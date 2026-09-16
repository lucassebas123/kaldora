-- =============================================================================
-- TRIVIA — la ronda pasa de 20 s a 10 s
-- =============================================================================
-- Pedido de producto: el "derretido" de 1000 pts ahora corre durante 10 s.
-- El host puede seguir pasando una duración custom (mínimo 5 s); lo que cambia
-- es el default del servidor y el fallback por si `salas.juego` llegara sin
-- `duracion_ms` (defensivo).
--
--   * `trivia_siguiente`: default 10000 ms (antes 20000).
--   * `trivia_responder`: fallback de duración 10000 ms (antes 20000).
--
-- `create or replace` conserva los permisos existentes (EXECUTE de host y
-- jugador como estaban).
-- =============================================================================

create or replace function public.trivia_siguiente(p_sala uuid, p_duracion_ms int default 10000)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_pregunta_id uuid;
  v_ronda int;
begin
  v_sala := public.sala_del_anfitrion(p_sala);

  -- Lock de la fila de sala: un doble disparo del host re-lee el estado
  -- fresco y se encadena (en vez de generar dos preguntas que se pisan).
  select * into v_sala from public.salas where id = p_sala for update;

  if v_sala.juego_actual = 'trivia' and v_sala.estado = 'jugando' then
    -- Ya hay trivia corriendo: siguiente pregunta.
    v_ronda := coalesce((v_sala.juego ->> 'ronda')::int, 0) + 1;
    v_pregunta_id := public.elegir_pregunta_trivia((v_sala.juego ->> 'pregunta_id')::uuid);
  else
    perform public.validar_arranque(p_sala);
    v_ronda := 1;
    v_pregunta_id := public.elegir_pregunta_trivia(null);
  end if;

  if v_pregunta_id is null then
    raise exception 'No hay preguntas de trivia cargadas' using errcode = 'P0001';
  end if;

  update public.salas
     set estado = 'jugando',
         juego_actual = 'trivia',
         juego = jsonb_build_object(
           'pregunta_id', v_pregunta_id,
           'inicio', clock_timestamp(),
           'duracion_ms', greatest(5000, coalesce(p_duracion_ms, 10000)),
           'ronda', v_ronda
         )
   where id = p_sala;
end;
$$;

create or replace function public.trivia_responder(
  p_token text,
  p_opcion int,
  p_pregunta_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_pregunta record;
  v_pregunta_id uuid;
  v_correcta boolean;
  v_transcurrido_ms numeric;
  v_duracion int;
  v_base int;
  v_racha_previa int;
  v_multiplicador int;
  v_puntos int;
begin
  select * into v_ctx from public.juego_activo(p_token, 'trivia');

  if p_opcion is null or p_opcion < 0 or p_opcion > 3 then
    raise exception 'Opción inválida' using errcode = 'P0001';
  end if;

  v_pregunta_id := (v_ctx.juego ->> 'pregunta_id')::uuid;

  -- V5: la opción elegida pertenece al enunciado que el jugador vio. Si el
  -- anfitrión ya rotó la pregunta, la respuesta se descarta (la UI está
  -- mutando a la pregunta nueva por Realtime/polling).
  if p_pregunta_id is not null and p_pregunta_id is distinct from v_pregunta_id then
    raise exception 'La pregunta ya cambió' using errcode = 'P0001';
  end if;
  if v_pregunta_id is null then
    raise exception 'La pregunta ya no está activa' using errcode = 'P0001';
  end if;

  -- Una sola respuesta por jugador y pregunta (guard anti doble-tap).
  begin
    insert into public.trivia_respuestas
      (id_sala, id_jugador, id_pregunta, opcion, correcta, puntos)
    values (
      v_ctx.sala_id, v_ctx.jugador_id, v_pregunta_id, p_opcion, false, 0
    );
  exception when unique_violation then
    raise exception 'Ya respondiste esta pregunta' using errcode = 'P0001';
  end;

  select * into v_pregunta
    from public.preguntas_trivia
   where id = v_pregunta_id;
  if not found then
    raise exception 'La pregunta ya no está activa' using errcode = 'P0001';
  end if;

  v_duracion := coalesce((v_ctx.juego ->> 'duracion_ms')::int, 10000);
  v_transcurrido_ms := greatest(0,
    extract(epoch from (clock_timestamp() - (v_ctx.juego ->> 'inicio')::timestamptz)) * 1000);

  if v_transcurrido_ms > v_duracion + 2000 then
    raise exception 'Se acabó el tiempo de esta pregunta' using errcode = 'P0001';
  end if;

  -- Lock de la fila: dos respuestas solapadas del mismo jugador ya no pueden
  -- leer la misma racha y pisarse (el update de puntos ya era atómico).
  select racha into v_racha_previa
    from public.jugadores where id = v_ctx.jugador_id for update;

  v_multiplicador := case
    when v_racha_previa >= 5 then 3
    when v_racha_previa >= 3 then 2
    else 1
  end;

  v_correcta := (p_opcion = v_pregunta.indice_correcto);
  v_base := case when v_correcta
    then greatest(0, round(1000 * (1 - least(v_transcurrido_ms, v_duracion) / v_duracion::numeric))::int)
    else 0
  end;
  v_puntos := v_base * v_multiplicador;

  update public.trivia_respuestas
     set correcta = v_correcta, puntos = v_puntos
   where id_jugador = v_ctx.jugador_id
     and id_pregunta = v_pregunta_id;

  update public.jugadores
     set racha = case when v_correcta then racha + 1 else 0 end,
         puntos = greatest(0, puntos + v_puntos)
   where id = v_ctx.jugador_id;

  return jsonb_build_object(
    'correcta', v_correcta,
    'puntos', v_puntos,
    'multiplicador', v_multiplicador,
    'base', v_base,
    'racha', case when v_correcta then v_racha_previa + 1 else 0 end
  );
end;
$$;
