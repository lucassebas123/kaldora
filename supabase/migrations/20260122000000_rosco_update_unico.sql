-- =============================================================================
-- ROSCO — un solo UPDATE por respuesta (la mitad de tráfico Realtime)
-- =============================================================================
-- Antes, cada `rosco_enviar` emitía DOS write-ahead records sobre la fila del
-- jugador: `sumar_puntos` (puntos) + `rosco_avanzar_interno` (estado del
-- rosco). Realtime publica cada versión de la fila a toda la sala: con 20
-- jugadores eran ~40 mensajes por respuesta en vez de ~20.
--
-- Ahora `rosco_avanzar_interno` recibe el delta de puntos y aplica estado +
-- puntos en UN único UPDATE. Misma semántica (piso en 0, ambas ramas —letra
-- encontrada o rosco terminado— aplican el delta exactamente una vez).
--
-- Medido en staging con scripts/test-carga-3-salas.mjs (3 salas × 20):
-- la fase de rosco bajó de ~5.300 a ~2.700 eventos entregados.
-- =============================================================================

-- El cambio de firma exige drop: `create or replace` dejaría las dos versiones.
drop function if exists public.rosco_avanzar_interno(uuid, jsonb, text);

create function public.rosco_avanzar_interno(
  p_jugador_id uuid,
  p_estados jsonb,
  p_desde text,
  p_delta_puntos int default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letra text;
  v_estados jsonb := p_estados;
  v_pregunta_id uuid;
  v_intentos int := 0;
begin
  loop
    v_letra := public.rosco_letra_siguiente(v_estados, p_desde);

    if v_letra is null then
      -- No quedan pendientes: rosco terminado (estado + puntos en un UPDATE).
      update public.jugadores
         set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null),
             puntos = greatest(0, puntos + p_delta_puntos)
       where id = p_jugador_id;
      return false;
    end if;

    select public.elegir_pregunta_letra(v_letra) into v_pregunta_id;

    if v_pregunta_id is not null then
      update public.jugadores
         set rosco = jsonb_build_object('l', v_letra, 'q', v_pregunta_id, 'e', v_estados, 't', false),
             puntos = greatest(0, puntos + p_delta_puntos)
       where id = p_jugador_id;
      return true;
    end if;

    -- Sin pregunta para esta letra: queda 4 (sin_pregunta) y se continúa.
    v_estados := jsonb_set(v_estados, array[v_letra], '4', true);
    p_desde := v_letra;
    v_intentos := v_intentos + 1;
    exit when v_intentos > 27;
  end loop;

  update public.jugadores
     set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null),
         puntos = greatest(0, puntos + p_delta_puntos)
   where id = p_jugador_id;
  return false;
end;
$$;

-- Igual que las demás funciones internas: sin execute para clientes.
revoke all on function public.rosco_avanzar_interno(uuid, jsonb, text, int)
  from public, anon, authenticated;

-- `rosco_enviar`: mismo lock de la migración 14, pero estado+puntos juntos.
create or replace function public.rosco_enviar(p_token text, p_respuesta text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx record;
  v_jugador_id uuid;
  v_pregunta record;
  v_limpiar text;
  v_valida text;
  v_correcta boolean;
  v_puntos int;
  v_estados jsonb;
begin
  -- LOCK del propio jugador ANTES de leer el estado: serializa acciones
  -- concurrentes del mismo dispositivo (doble-tap / enviar+pasar). Diferentes
  -- jugadores tocan filas distintas: cero contención entre los 10.
  select j.id into v_jugador_id
    from public.jugadores j
    join public.sesiones_jugador s on s.id_jugador = j.id
   where s.token = p_token
   for update of j;
  if v_jugador_id is null then
    raise exception 'Sesión de jugador inválida' using errcode = 'P0001';
  end if;

  select * into v_ctx from public.rosco_ctx(p_token);

  if not v_ctx.tiempo_ok then
    raise exception 'El tiempo del rosco terminó' using errcode = 'P0001';
  end if;
  if v_ctx.terminado then
    raise exception 'Ya terminaste tu rosco' using errcode = 'P0001';
  end if;
  if v_ctx.letra is null or v_ctx.pregunta_id is null then
    raise exception 'No hay letra activa' using errcode = 'P0001';
  end if;

  select respuesta into v_pregunta
    from public.preguntas
   where id = v_ctx.pregunta_id::uuid;
  if not found then
    raise exception 'No hay pregunta cargada para esta letra' using errcode = 'P0001';
  end if;

  -- Tope defensivo: una respuesta del rosco no pasa de 60 caracteres.
  v_limpiar := public.normalizar_palabra(left(p_respuesta, 60));
  v_valida := public.normalizar_palabra(v_pregunta.respuesta);

  if v_limpiar = '' then
    v_correcta := false;
  else
    v_correcta := v_limpiar = v_valida
      or levenshtein(v_limpiar, v_valida) <= greatest(1, floor(char_length(v_valida) / 4.0)::int);
  end if;

  v_puntos := case when v_correcta then 100 else -50 end;
  v_estados := jsonb_set(coalesce(v_ctx.estados, '{}'::jsonb),
                         array[v_ctx.letra],
                         to_jsonb(case when v_correcta then 1 else 2 end), true);

  -- Auditoría (una respuesta por letra: la pasapalabra no inserta).
  begin
    insert into public.rosco_respuestas (id_sala, id_jugador, letra, correcta, puntos)
    values (v_ctx.sala_id, v_ctx.jugador_id, v_ctx.letra, v_correcta, v_puntos);
  exception when unique_violation then
    raise exception 'Ya respondiste esta letra' using errcode = 'P0001';
  end;

  -- UN solo UPDATE: estado del rosco + puntos.
  perform public.rosco_avanzar_interno(v_ctx.jugador_id, v_estados, v_ctx.letra, v_puntos);

  return jsonb_build_object(
    'correcta', v_correcta,
    'puntos', v_puntos,
    'letra', (select rosco ->> 'l' from public.jugadores where id = v_ctx.jugador_id),
    'terminado', coalesce((select (rosco ->> 't')::boolean from public.jugadores where id = v_ctx.jugador_id), false)
  );
end;
$$;
