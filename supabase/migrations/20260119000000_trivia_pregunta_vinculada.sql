-- =============================================================================
-- FIX V5 — Trivia: la respuesta queda atada a la pregunta que el jugador vio
-- =============================================================================
-- Hallazgo V5 de docs/auditoria-tecnica.md: `trivia_responder` tomaba el
-- `pregunta_id` del snapshot `salas.juego` sin compararlo con la pregunta que
-- el jugador tenía en pantalla. Con una respuesta en vuelo justo cuando el
-- anfitrión rotaba la pregunta, esa respuesta se registraba (y puntuaba)
-- contra la pregunta NUEVA: una opción elegida sobre el enunciado viejo.
--
-- Ahora el cliente manda `p_pregunta_id` (la que renderizó) y el servidor
-- rechaza la respuesta si no coincide con la activa. El parámetro es opcional
-- para no romper bundles cacheados (AvisoActualizacion avisa igual); el
-- frontend nuevo SIEMPRE lo envía.
-- =============================================================================

-- El cambio de firma exige recrear: `create or replace` con otro argumento
-- dejaría DOS funciones y PostgREST no sabría cuál elegir.
drop function if exists public.trivia_responder(text, int);

create function public.trivia_responder(
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

  v_duracion := coalesce((v_ctx.juego ->> 'duracion_ms')::int, 20000);
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

-- El `drop` se llevó los grants: se re-otorgan explícitos.
grant execute on function public.trivia_responder(text, int, uuid) to anon, authenticated;
