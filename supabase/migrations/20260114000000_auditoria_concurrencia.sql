-- =============================================================================
-- AUDITORÍA DE CONCURRENCIA — Locks faltantes (race conditions)
-- =============================================================================
-- Hallazgos (auditoría con 10 jugadores concurrentes):
--
-- 1. SUPERVIVENCIA — respuesta vs procesar (race real):
--    `supervivencia_responder` no serializaba contra `supervivencia_procesar`
--    (que sí toma `for update` de la fila de sala). El cliente llama a
--    `procesar` ~400 ms después del deadline, pero la gracia de respuesta es
--    de +1500 ms: una respuesta en vuelo podía confirmarse DESPUÉS del
--    snapshot del procesar → jugador ELIMINADO con respuesta correcta
--    registrada (o eliminado injustamente). Fix: la respuesta toma el MISMO
--    lock de la fila de sala y re-chequea (eliminado + tiempo) bajo lock:
--    o entra primero y el procesar la ve, o pierde la ventana. Determinista.
--
-- 2. ROSCO — lost update del jsonb `jugadores.rosco`:
--    `rosco_enviar`/`rosco_pasar` leían el estado del jugador sin lock y
--    escribían encima (`rosco_avanzar_interno` hace un overwrite ciego).
--    Dos acciones rápidas del mismo dispositivo (doble-tap, enviar+pasar)
--    podían pisarse: letra marcada "pendiente" (3) CON auditoría ya
--    insertada → unique_violation al reintentar → rosco del jugador TRABADO.
--    Fix: `for update` de la fila del jugador ANTES de leer el estado, en
--    enviar/pasar/cerrar. (Diferentes jugadores tocan filas distintas: cero
--    contención entre los 10.)
--
-- 3. ACCIONES DEL HOST — doble disparo (doble-click):
--    `trivia_siguiente`, `supervivencia_siguiente`, `basta_iniciar_ronda`,
--    `pausar_partida` y `reanudar_partida` leían la sala sin lock y
--    actualizaban: dos disparos simultáneos generaban DOS preguntas/letras
--    (la segunda pisa la primera, con respuestas ya emitidas contra la
--    vieja) o desplazaban los relojes DOS veces al reanudar una pausa.
--    Fix: `for update` de la fila de sala al inicio: el segundo disparo
--    re-lee el estado fresco y se encadena de forma determinista.
--    (Las respuestas de los jugadores NO lockean la sala — salvo
--    supervivencia — así que no hay contención con las respuestas masivas.)
--
-- 4. ROSCO — error crudo por doble respuesta de la misma letra:
--    el insert de auditoría tiene unique (id_jugador, letra); un doble-tap
--    sobre la misma letra bubbeaba el error crudo de Postgres ("duplicate
--    key"). Fix: captura unique_violation → mensaje limpio 'Ya respondiste
--    esta letra' (y con el lock de (2) la segunda acción ni siquiera llega
--    a insertar sobre un estado viejo).
--
-- Lo que YA era correcto (sin cambios):
--   * sumar_puntos: `puntos = greatest(0, puntos + delta)` — atómico.
--   * Anti doble-tap por constraints únicos en trivia/supervivencia.
--   * basta_declarar_completo / basta_cerrar_ronda: lock + re-check.
--   * basta_enviar: upsert por (jugador, categoría).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. SUPERVIVENCIA: respuesta serializada contra el procesar
-- -----------------------------------------------------------------------------
create or replace function public.supervivencia_responder(p_token text, p_respuesta boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_sala public.salas;
  v_jugador public.jugadores;
  v_pregunta record;
  v_correcta boolean;
  v_transcurrido numeric;
begin
  select * into v_ctx from public.juego_activo(p_token, 'supervivencia');

  -- MISMO lock que supervivencia_procesar: la ronda se resuelve en un orden
  -- único. Sin esto, una respuesta en vuelo podía confirmarse después del
  -- snapshot del procesar (eliminado con respuesta correcta registrada).
  select * into v_sala from public.salas where id = v_ctx.sala_id for update;

  select * into v_jugador from public.jugadores where id = v_ctx.jugador_id;
  if v_jugador.eliminado then
    raise exception 'Estás eliminado: solo podés mirar' using errcode = 'P0001';
  end if;

  v_transcurrido := extract(epoch from (clock_timestamp() - (v_sala.juego ->> 'inicio')::timestamptz));
  if v_transcurrido * 1000 > coalesce((v_sala.juego ->> 'duracion_ms')::int, 10000) + 1500 then
    raise exception 'Se acabó el tiempo de esta ronda' using errcode = 'P0001';
  end if;

  select es_verdadera into v_pregunta
    from public.preguntas_supervivencia
   where id = (v_sala.juego ->> 'pregunta_id')::uuid;
  if not found then
    raise exception 'La pregunta ya no está activa' using errcode = 'P0001';
  end if;

  v_correcta := (p_respuesta = v_pregunta.es_verdadera);

  begin
    insert into public.supervivencia_respuestas
      (id_sala, id_jugador, id_pregunta, respuesta, correcta)
    values (v_ctx.sala_id, v_ctx.jugador_id, (v_sala.juego ->> 'pregunta_id')::uuid,
            p_respuesta, v_correcta);
  exception when unique_violation then
    raise exception 'Ya respondiste esta ronda' using errcode = 'P0001';
  end;

  if v_correcta then
    perform public.sumar_puntos(v_ctx.jugador_id, 25);
  else
    update public.jugadores set eliminado = true where id = v_ctx.jugador_id;
  end if;

  return jsonb_build_object('correcta', v_correcta, 'eliminado', not v_correcta);
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. ROSCO: lock por jugador (anti doble-tap, sin lost update)
-- -----------------------------------------------------------------------------
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

  v_limpiar := public.normalizar_palabra(p_respuesta);
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

  perform public.sumar_puntos(v_ctx.jugador_id, v_puntos);

  perform public.rosco_avanzar_interno(v_ctx.jugador_id, v_estados, v_ctx.letra);

  return jsonb_build_object(
    'correcta', v_correcta,
    'puntos', v_puntos,
    'letra', (select rosco ->> 'l' from public.jugadores where id = v_ctx.jugador_id),
    'terminado', coalesce((select (rosco ->> 't')::boolean from public.jugadores where id = v_ctx.jugador_id), false)
  );
end;
$$;

create or replace function public.rosco_pasar(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_jugador_id uuid;
  v_estados jsonb;
begin
  -- Mismo lock que rosco_enviar: enviar+pasar simultáneos se ordenan.
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
  if v_ctx.letra is null then
    raise exception 'No hay letra activa' using errcode = 'P0001';
  end if;

  -- 3 = pasapalabra: pendiente, sin puntos ni error.
  v_estados := jsonb_set(coalesce(v_ctx.estados, '{}'::jsonb),
                         array[v_ctx.letra], '3', true);

  perform public.rosco_avanzar_interno(v_ctx.jugador_id, v_estados, v_ctx.letra);

  return jsonb_build_object(
    'letra', (select rosco ->> 'l' from public.jugadores where id = v_ctx.jugador_id),
    'terminado', coalesce((select (rosco ->> 't')::boolean from public.jugadores where id = v_ctx.jugador_id), false)
  );
end;
$$;

create or replace function public.rosco_cerrar(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_jugador_id uuid;
  v_jugador_row public.jugadores;
begin
  -- Mismo lock que enviar/pasar, ANTES de leer el estado.
  select j.id into v_jugador_id
    from public.jugadores j
    join public.sesiones_jugador s on s.id_jugador = j.id
   where s.token = p_token
   for update of j;
  if v_jugador_id is null then
    raise exception 'Sesión de jugador inválida' using errcode = 'P0001';
  end if;

  select * into v_ctx from public.rosco_ctx(p_token);

  if not v_ctx.tiempo_ok and not v_ctx.terminado then
    return jsonb_build_object('cerrado', false);
  end if;

  select * into v_jugador_row from public.jugadores where id = v_ctx.jugador_id;
  update public.jugadores
     set rosco = coalesce(v_jugador_row.rosco, '{}'::jsonb) || jsonb_build_object('t', true)
   where id = v_ctx.jugador_id;

  return jsonb_build_object('cerrado', true);
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. ACCIONES DEL HOST: doble disparo serializado
-- -----------------------------------------------------------------------------
create or replace function public.trivia_siguiente(p_sala uuid, p_duracion_ms int default 20000)
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
           'duracion_ms', greatest(5000, coalesce(p_duracion_ms, 20000)),
           'ronda', v_ronda
         )
   where id = p_sala;
end;
$$;

create or replace function public.supervivencia_siguiente(p_sala uuid, p_duracion_ms int default 10000)
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

  -- Mismo lock que trivia_siguiente (anti doble disparo).
  select * into v_sala from public.salas where id = p_sala for update;

  if v_sala.juego_actual = 'supervivencia' and v_sala.estado = 'jugando' then
    v_ronda := coalesce((v_sala.juego ->> 'ronda')::int, 0) + 1;
    v_pregunta_id := public.elegir_pregunta_supervivencia((v_sala.juego ->> 'pregunta_id')::uuid);
  else
    perform public.validar_arranque(p_sala);
    v_ronda := 1;
    v_pregunta_id := public.elegir_pregunta_supervivencia(null);
  end if;

  if v_pregunta_id is null then
    raise exception 'No hay preguntas de supervivencia cargadas' using errcode = 'P0001';
  end if;

  update public.salas
     set estado = 'jugando',
         juego_actual = 'supervivencia',
         juego = jsonb_build_object(
           'pregunta_id', v_pregunta_id,
           'inicio', clock_timestamp(),
           'duracion_ms', greatest(4000, coalesce(p_duracion_ms, 10000)),
           'ronda', v_ronda
         )
   where id = p_sala;
end;
$$;

create or replace function public.basta_iniciar_ronda(p_sala uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_letras text[] := array['A','B','C','D','E','F','G','H','I','J','K','L','M','N','Ñ',
                           'O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  v_letra text;
  v_ultima text;
  v_categorias uuid[];
begin
  v_sala := public.sala_del_anfitrion(p_sala);

  -- Lock de la fila de sala (anti doble disparo: no generar dos rondas).
  select * into v_sala from public.salas where id = p_sala for update;

  if v_sala.juego_actual = 'basta' and v_sala.estado = 'jugando'
     and (v_sala.juego ->> 'fase') in ('escribiendo', 'cuenta_atras') then
    raise exception 'Ya hay una ronda de Basta en curso' using errcode = 'P0001';
  end if;

  if v_sala.estado = 'en_espera' then
    perform public.validar_arranque(p_sala);
  elsif v_sala.estado not in ('jugando', 'finalizado') then
    raise exception 'La sala no permite iniciar una ronda' using errcode = 'P0001';
  end if;

  -- Letra distinta de la ronda anterior.
  v_ultima := v_sala.juego ->> 'letra';
  select l into v_letra
    from unnest(v_letras) as l
   where l <> coalesce(v_ultima, '')
   order by random()
   limit 1;

  select array_agg(id) into v_categorias
    from (select id from public.categorias_basta order by random() limit 5) c;

  if v_categorias is null or cardinality(v_categorias) < 5 then
    raise exception 'Necesitás al menos 5 categorías cargadas' using errcode = 'P0001';
  end if;

  -- Snapshot de puntos por jugador para que re-cerrar la ronda sea idempotente.
  update public.salas
     set estado = 'jugando',
         juego_actual = 'basta',
         juego = jsonb_build_object(
           'fase', 'escribiendo',
           'letra', v_letra,
           'categorias', to_jsonb(v_categorias),
           'inicio', clock_timestamp(),
           'deadline', null,
           'completado_por', null,
           'puntos_base', coalesce(
             (select jsonb_object_agg(id, puntos) from public.jugadores where id_sala = p_sala),
             '{}'::jsonb)
         )
   where id = p_sala;

  return jsonb_build_object('letra', v_letra, 'categorias', to_jsonb(v_categorias));
end;
$$;

-- Pausa/Reanudar con lock: el doble-fire de `reanudar` desplazaba los
-- relojes DOS veces (cada llamada leía el mismo `pausa_en` y sumaba el
-- mismo delta sobre resultados distintos).
create or replace function public.pausar_partida(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_del_anfitrion(p_sala);

  select * into v_sala from public.salas where id = p_sala for update;
  if v_sala.estado <> 'jugando' then return; end if;

  update public.salas
     set estado = 'pausado',
         juego = jsonb_set(v_sala.juego, '{pausa_en}', to_jsonb(clock_timestamp()))
   where id = p_sala;
end;
$$;

create or replace function public.reanudar_partida(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_del_anfitrion(p_sala);

  select * into v_sala from public.salas where id = p_sala for update;
  if v_sala.estado <> 'pausado' then return; end if;

  update public.salas
     set estado = 'jugando',
         juego = public.reanudar_relojes(v_sala.juego)
   where id = p_sala;
end;
$$;
