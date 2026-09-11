-- =============================================================================
-- AUDITORÍA v2 — Correcciones de lógica, concurrencia y seguridad
-- =============================================================================
-- Hallazgos de la auditoría integral (frontend + SQL) corregidos acá:
--
-- 1. BASTA multi-ronda: `basta_iniciar_ronda` NO borraba las respuestas de la
--    ronda anterior y `basta_cerrar_ronda` sumaba TODAS las filas de la sala.
--    Con 2+ rondas, la ronda previa se contaba de nuevo (puntos inflados) y
--    contaminaba la unicidad. Se limpia la sala al iniciar cada ronda.
-- 2. `trivia_responder` leía `racha` sin lock (lost update en respuestas
--    solapadas del mismo jugador). Ahora toma `for update` de su fila.
-- 3. `juego_activo` fallaba ABIERTO si `juego_actual` era NULL (comparación
--    NULL). Se usa `is distinct from`.
-- 4. `seleccionar_juego` no validaba estado: en plena partida dejaba
--    `juego_actual = null` y rompía todos los RPC de juego. Solo en lobby.
-- 5. `crear_sala` (reescrita en la migración 16 por el tope de 50) perdió el
--    `exigir_admin()`: un autenticado fuera de `admins_autorizados` podía
--    crear salas. Se reincorpora.
-- 6. `rosco_iniciar` era el único RPC de host sin lock: doble disparo podía
--    pisar `juego.inicio` y el rosco de todos. Se agrega `for update`.
-- 7. `rosco_ctx` (recreada con `drop` en la migración 11) recuperó el EXECUTE
--    implícito a PUBLIC: helper interno expuesto. Se revoca.
-- 8. `registros_jugadores(id_jugador)` sin índice: cada DELETE de jugador
--    (salir/expulsar/borrar sala) escaneaba toda la tabla por el FK.
-- 9. `cambiar_rol_admin` permitía degradar al ÚNICO dueño (lockout total).
-- 10. `entrar_con_identificador`/`unirse_sala` chequeaban cupo antes de
--     reutilizar la fila de un jugador YA presente, y el registro duplicaba
--     la fila del jugador si la cuenta ya estaba en la sala.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. BASTA: limpiar la ronda anterior al iniciar una nueva
-- -----------------------------------------------------------------------------
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

  -- La ronda empieza de cero: las filas de rondas anteriores (upserts por
  -- id_jugador+id_categoria) contaminarían el puntaje y la unicidad.
  delete from public.respuestas_basta where id_sala = p_sala;

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

-- -----------------------------------------------------------------------------
-- 2. TRIVIA: racha sin lost update (lock de la fila del jugador)
-- -----------------------------------------------------------------------------
create or replace function public.trivia_responder(p_token text, p_opcion int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_pregunta record;
  v_correcta boolean;
  v_transcurrido_ms numeric;
  v_duracion int;
  v_base int;
  v_racha_previa int;
  v_multiplicador int;
  v_puntos int;
begin
  select * into v_ctx from public.juego_activo(p_token, 'trivia');

  -- Una sola respuesta por jugador y pregunta (guard anti doble-tap).
  begin
    insert into public.trivia_respuestas
      (id_sala, id_jugador, id_pregunta, opcion, correcta, puntos)
    values (
      v_ctx.sala_id, v_ctx.jugador_id, (v_ctx.juego ->> 'pregunta_id')::uuid,
      p_opcion, false, 0
    );
  exception when unique_violation then
    raise exception 'Ya respondiste esta pregunta' using errcode = 'P0001';
  end;

  select * into v_pregunta
    from public.preguntas_trivia
   where id = (v_ctx.juego ->> 'pregunta_id')::uuid;
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
     and id_pregunta = (v_ctx.juego ->> 'pregunta_id')::uuid;

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

-- -----------------------------------------------------------------------------
-- 3. juego_activo: comparación NULL-safe
-- -----------------------------------------------------------------------------
create or replace function public.juego_activo(
  p_token text,
  p_juego public.juego_tipo
)
returns table (sala_id uuid, jugador_id uuid, juego jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
begin
  v_jugador := public.jugador_por_token(p_token);

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if not found then
    raise exception 'La sala no existe' using errcode = 'P0001';
  end if;
  if v_sala.estado <> 'jugando' then
    raise exception 'La partida no está en curso' using errcode = 'P0001';
  end if;
  -- `is distinct from` cubre juego_actual NULL (antes fallaba abierto).
  if v_sala.juego_actual is distinct from p_juego then
    raise exception 'El juego activo no corresponde' using errcode = 'P0001';
  end if;

  return query select v_sala.id, v_jugador.id, v_sala.juego;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. seleccionar_juego: solo desde el lobby
-- -----------------------------------------------------------------------------
create or replace function public.seleccionar_juego(p_sala uuid, p_juego text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_estado text;
begin
  perform public.sala_del_anfitrion(p_sala);

  if p_juego is not null and p_juego not in ('rosco', 'trivia', 'basta', 'supervivencia') then
    raise exception 'Juego desconocido' using errcode = 'P0001';
  end if;

  select estado into v_estado from public.salas where id = p_sala for update;
  if v_estado <> 'en_espera' then
    raise exception 'Volvé al lobby para cambiar de juego' using errcode = 'P0001';
  end if;

  update public.salas
     set juego_actual = (p_juego::public.juego_tipo),
         juego = '{}'::jsonb
   where id = p_sala;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. crear_sala: reincorporar exigir_admin (regresión de la migración 16)
-- -----------------------------------------------------------------------------
create or replace function public.crear_sala()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_codigo text;
  v_sala public.salas;
  v_intento int;
begin
  perform public.exigir_admin();

  if (select count(*) from public.salas where id_anfitrion = v_uid) >= 50 then
    raise exception 'Tenés demasiadas salas (50). Borrá alguna desde el panel' using errcode = 'P0001';
  end if;

  for v_intento in 1..10 loop
    v_codigo := to_char(floor(random() * 900000 + 100000)::int, 'FM000000');
    begin
      insert into public.salas (codigo, id_anfitrion)
      values (v_codigo, v_uid)
      returning * into v_sala;
      return jsonb_build_object('id', v_sala.id, 'codigo', v_sala.codigo);
    exception when unique_violation then
      null; -- PIN repetido: probar otro.
    end;
  end loop;

  raise exception 'No se pudo generar un PIN único' using errcode = 'P0001';
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. rosco_iniciar: lock anti doble disparo
-- -----------------------------------------------------------------------------
create or replace function public.rosco_iniciar(p_sala uuid, p_duracion_seg int default 150)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_duracion int := greatest(60, least(1200, coalesce(p_duracion_seg, 150)));
begin
  perform public.sala_del_anfitrion(p_sala);
  -- Serializa el doble disparo: la segunda llamada ve estado 'jugando'.
  select * into v_sala from public.salas where id = p_sala for update;
  perform public.validar_arranque(p_sala);

  update public.jugadores
     set rosco = jsonb_build_object('l', 'A', 'e', '{}'::jsonb, 't', false,
                'q', public.elegir_pregunta_letra('A'))
   where id_sala = p_sala;

  update public.salas
     set estado = 'jugando',
         juego_actual = 'rosco',
         juego = jsonb_build_object(
           'inicio', clock_timestamp(),
           'duracion_ms', v_duracion * 1000
         )
   where id = p_sala;
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. rosco_ctx: helper interno (revocado)
-- -----------------------------------------------------------------------------
revoke all on function public.rosco_ctx(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 8. Índice del FK registros_jugadores.id_jugador
-- -----------------------------------------------------------------------------
create index if not exists idx_registros_jugadores_id_jugador
  on public.registros_jugadores (id_jugador);

-- -----------------------------------------------------------------------------
-- 9. cambiar_rol_admin: no degradar al último dueño
-- -----------------------------------------------------------------------------
create or replace function public.cambiar_rol_admin(p_id uuid, p_rol text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.es_dueno() then
    raise exception 'Solo el dueño gestiona administradores' using errcode = '42501';
  end if;
  if p_rol not in ('dueño', 'operador') then
    raise exception 'Rol inválido' using errcode = 'P0001';
  end if;
  if p_rol = 'operador'
     and exists (select 1 from public.admins_autorizados where id = p_id and rol = 'dueño')
     and not exists (select 1 from public.admins_autorizados where rol = 'dueño' and id <> p_id) then
    raise exception 'No podés degradar al único dueño' using errcode = 'P0001';
  end if;
  update public.admins_autorizados set rol = p_rol where id = p_id;
end;
$$;

-- -----------------------------------------------------------------------------
-- 10a. unirse_sala: reutiliza la fila del jugador si la cuenta ya está en la sala
-- -----------------------------------------------------------------------------
create or replace function public.unirse_sala(
  p_codigo text,
  p_nickname text,
  p_nombre text,
  p_apellido text,
  p_telefono text,
  p_correo text,
  p_icono text default 'Star',
  p_color text default 'bg-purple-500'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_jugador public.jugadores;
  v_cuenta public.registros_jugadores;
  v_token text;
  v_pin text;
  v_recurrente boolean := false;
  v_nick text := btrim(p_nickname);
  v_nombre text := btrim(p_nombre);
  v_apellido text := btrim(p_apellido);
  v_telefono text := btrim(p_telefono);
  v_correo text := btrim(p_correo);
  v_icono text := btrim(p_icono);
  v_color text := btrim(p_color);
begin
  select * into v_sala from public.salas where codigo = btrim(p_codigo);
  if not found then
    raise exception 'No existe una sala con ese PIN' using errcode = 'P0001';
  end if;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La partida ya empezó. Pedile al anfitrión que vuelva al lobby' using errcode = 'P0001';
  end if;

  if v_nick = '' or char_length(v_nick) > 20 then
    raise exception 'El nickname debe tener entre 1 y 20 caracteres' using errcode = 'P0001';
  end if;
  if v_nombre = '' or char_length(v_nombre) > 40 then
    raise exception 'Ingresá tu nombre (hasta 40 caracteres)' using errcode = 'P0001';
  end if;
  if v_apellido = '' or char_length(v_apellido) > 40 then
    raise exception 'Ingresá tu apellido (hasta 40 caracteres)' using errcode = 'P0001';
  end if;
  if v_telefono !~ '^\+?[0-9 ()-]{6,20}$' then
    raise exception 'Ingresá un número de celular válido' using errcode = 'P0001';
  end if;
  if v_correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_correo) > 120 then
    raise exception 'Ingresá un correo electrónico válido' using errcode = 'P0001';
  end if;

  if v_icono !~ '^[A-Za-z][A-Za-z0-9]{0,39}$' then
    v_icono := 'Star';
  end if;
  if v_color !~ '^[a-zA-Z0-9\-]{1,60}$' then
    v_color := 'bg-purple-500';
  end if;

  -- ¿Ya existe una cuenta vigente con ese correo o celular? Es un recurrente:
  -- se le devuelve SU PIN y sus datos se rotan (la fila vieja queda historial).
  select * into v_cuenta
    from public.registros_jugadores
   where vigente
     and (
       lower(btrim(correo)) = lower(v_correo)
       or (char_length(public.normalizar_telefono(v_telefono)) >= 6
           and public.normalizar_telefono(telefono) = public.normalizar_telefono(v_telefono))
     )
   order by creado_en desc
   limit 1;

  if found then
    v_recurrente := true;
    v_pin := v_cuenta.pin_jugador;
  end if;
  if v_pin is null then
    v_pin := public.pin_jugador_unico();
  end if;

  -- ¿La cuenta ya tiene fila en ESTA sala? Se reutiliza (conserva puntos) y
  -- se renueva el token; si no, recién ahí se evalúa el cupo.
  if v_recurrente and v_cuenta.id_jugador is not null then
    select * into v_jugador
      from public.jugadores
     where id = v_cuenta.id_jugador and id_sala = v_sala.id;
  end if;

  if v_jugador.id is not null then
    begin
      update public.jugadores
         set nickname = v_nick, icono = v_icono, color = v_color
       where id = v_jugador.id;
      delete from public.sesiones_jugador where id_jugador = v_jugador.id;
      insert into public.sesiones_jugador (id_jugador) values (v_jugador.id);
    exception when unique_violation then
      raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
    end;
  else
    if (select count(*) from public.jugadores where id_sala = v_sala.id) >= 200 then
      raise exception 'La sala está llena (máximo 200 jugadores)' using errcode = 'P0001';
    end if;

    begin
      insert into public.jugadores (id_sala, nickname, icono, color)
      values (v_sala.id, v_nick, v_icono, v_color)
      returning * into v_jugador;

      insert into public.sesiones_jugador (id_jugador) values (v_jugador.id);
    exception when unique_violation then
      raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
    end;
  end if;

  -- Rota la cuenta: lo anterior queda como historial, la fila nueva vigente
  -- (mismo PIN). Se desmarca la vieja ANTES de insertar por los índices únicos.
  if v_recurrente then
    update public.registros_jugadores set vigente = false where id = v_cuenta.id;
  end if;

  begin
    insert into public.registros_jugadores
      (id_jugador, nickname, nombre, apellido, telefono, correo,
       pin_jugador, vigente, ultimo_acceso)
    values
      (v_jugador.id, v_nick, v_nombre, v_apellido, v_telefono, v_correo,
       v_pin, true, now());
  exception when unique_violation then
    raise exception 'Ese correo o celular ya está asociado a otra cuenta. Usá "Ingresa aquí" con tu PIN.' using errcode = '23505';
  end;

  select token into v_token from public.sesiones_jugador where id_jugador = v_jugador.id;

  return jsonb_build_object(
    'idSala', v_sala.id,
    'codigo', v_sala.codigo,
    'estado', v_sala.estado,
    'juegoActual', v_sala.juego_actual,
    'idJugador', v_jugador.id,
    'nickname', v_jugador.nickname,
    'token', v_token,
    'pinJugador', v_pin,
    'recurrente', v_recurrente
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 10b. entrar_con_identificador: cupo recién si hay que crear fila nueva
-- -----------------------------------------------------------------------------
create or replace function public.entrar_con_identificador(
  p_codigo text,
  p_identificador text,
  p_icono text default 'Star',
  p_color text default 'bg-purple-500'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_cuenta public.registros_jugadores;
  v_jugador public.jugadores;
  v_token text;
  v_ident text := btrim(p_identificador);
  v_digitos text := public.normalizar_telefono(p_identificador);
  v_icono text := btrim(p_icono);
  v_color text := btrim(p_color);
  v_nick_base text;
  v_nick text;
  v_pin text;
  v_intento int := 1;
begin
  select * into v_sala from public.salas where codigo = btrim(p_codigo);
  if not found then
    raise exception 'No existe una sala con ese PIN' using errcode = 'P0001';
  end if;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La partida ya empezó. Pedile al anfitrión que vuelva al lobby' using errcode = 'P0001';
  end if;

  if v_ident is null or char_length(v_ident) < 3 or char_length(v_ident) > 120 then
    raise exception 'Ingresá tu correo, celular o PIN de jugador' using errcode = 'P0001';
  end if;

  -- Búsqueda OR: PIN exacto · correo (case-insensitive) · celular (dígitos).
  select * into v_cuenta
    from public.registros_jugadores
   where vigente
     and (
       upper(btrim(pin_jugador)) = upper(v_ident)
       or lower(btrim(correo)) = lower(v_ident)
       or (char_length(v_digitos) >= 6
           and public.normalizar_telefono(telefono) = v_digitos)
     )
   order by creado_en desc
   limit 1;

  if not found then
    raise exception 'No encontramos tu registro. Revisá el dato o volvé con "Regístrate aquí".' using errcode = 'P0001';
  end if;

  v_pin := v_cuenta.pin_jugador;
  if v_pin is null then
    v_pin := public.pin_jugador_unico();
    update public.registros_jugadores set pin_jugador = v_pin where id = v_cuenta.id;
  end if;

  -- ¿Ya está en ESTA sala (misma cuenta)? Se reutiliza su fila: conserva
  -- nickname, avatar y puntos; solo se le renueva el token de sesión.
  if v_cuenta.id_jugador is not null then
    select * into v_jugador
      from public.jugadores
     where id = v_cuenta.id_jugador and id_sala = v_sala.id;
    if found then
      delete from public.sesiones_jugador where id_jugador = v_jugador.id;
      insert into public.sesiones_jugador (id_jugador)
      values (v_jugador.id)
      returning token into v_token;

      update public.registros_jugadores
         set id_jugador = v_jugador.id,
             ultimo_acceso = now(),
             actualizado_en = now()
       where id = v_cuenta.id;

      return jsonb_build_object(
        'idSala', v_sala.id,
        'codigo', v_sala.codigo,
        'estado', v_sala.estado,
        'juegoActual', v_sala.juego_actual,
        'idJugador', v_jugador.id,
        'nickname', v_jugador.nickname,
        'token', v_token,
        'pinJugador', v_pin,
        'recurrente', true
      );
    end if;
  end if;

  -- Fila nueva: recién acá se evalúa el cupo (un jugador ya presente puede
  -- volver a entrar aunque la sala esté llena).
  if (select count(*) from public.jugadores where id_sala = v_sala.id) >= 200 then
    raise exception 'La sala está llena (máximo 200 jugadores)' using errcode = 'P0001';
  end if;

  -- Nickname: el de su cuenta (o su nombre); se desambigua si está tomado.
  v_nick_base := nullif(btrim(coalesce(v_cuenta.nickname, '')), '');
  if v_nick_base is null then
    v_nick_base := nullif(btrim(coalesce(v_cuenta.nombre, '')), '');
  end if;
  if v_nick_base is null then
    v_nick_base := 'Jugador';
  end if;
  v_nick_base := left(v_nick_base, 20);

  v_nick := v_nick_base;
  while exists (
    select 1 from public.jugadores
     where id_sala = v_sala.id and lower(btrim(nickname)) = lower(v_nick)
  ) loop
    v_intento := v_intento + 1;
    if v_intento > 99 then
      raise exception 'No hay nombres libres en esta sala' using errcode = 'P0001';
    end if;
    v_nick := left(v_nick_base, greatest(1, 20 - char_length(v_intento::text) - 1))
              || '-' || v_intento::text;
  end loop;

  if v_icono !~ '^[A-Za-z][A-Za-z0-9]{0,39}$' then
    v_icono := 'Star';
  end if;
  if v_color !~ '^[a-zA-Z0-9\-]{1,60}$' then
    v_color := 'bg-purple-500';
  end if;

  begin
    insert into public.jugadores (id_sala, nickname, icono, color)
    values (v_sala.id, v_nick, v_icono, v_color)
    returning * into v_jugador;
  exception when unique_violation then
    raise exception 'Ese nombre se está usando en esta sala. Reintentá en unos segundos.' using errcode = '23505';
  end;

  insert into public.sesiones_jugador (id_jugador)
  values (v_jugador.id)
  returning token into v_token;

  update public.registros_jugadores
     set id_jugador = v_jugador.id,
         ultimo_acceso = now(),
         actualizado_en = now()
   where id = v_cuenta.id;

  return jsonb_build_object(
    'idSala', v_sala.id,
    'codigo', v_sala.codigo,
    'estado', v_sala.estado,
    'juegoActual', v_sala.juego_actual,
    'idJugador', v_jugador.id,
    'nickname', v_jugador.nickname,
    'token', v_token,
    'pinJugador', v_pin,
    'recurrente', true
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- Permisos (los reemplazos preservan los grants existentes; explícitos igual)
-- -----------------------------------------------------------------------------
grant execute on function public.unirse_sala(text, text, text, text, text, text, text, text)
  to anon, authenticated;
grant execute on function public.entrar_con_identificador(text, text, text, text)
  to anon, authenticated;
revoke all on function public.rosco_ctx(text) from public, anon, authenticated;
