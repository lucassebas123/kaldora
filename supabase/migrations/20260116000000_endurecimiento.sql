-- =============================================================================
-- ENDURECIMIENTO — Estándares de seguridad sin fricción para usuarios
-- =============================================================================
-- Auditoría de seguridad (todos los checks verificados contra la base viva):
--
-- ✓ 15/15 tablas con RLS habilitado
-- ✓ Cero permisos de escritura de anon/authenticated sobre tablas (todo via RPC)
-- ✓ Realtime respeta permisos por columna (probado empíricamente: un anon
--   suscripto a `preguntas` recibe la fila SIN la respuesta)
-- ✓ sesiones_jugador sin políticas ni grants · registros_jugadores sin políticas
-- ✓ Tokens de 32 hex generados server-side · signup público deshabilitado
-- ✓ npm audit: 0 vulnerabilidades
--
-- Medidas aplicadas en esta migración (ninguna cambia la experiencia):
--
-- 1. `preguntas` (banco con RESPUESTAS) fuera de la publicación Realtime.
--    Hoy Realtime recorta la columna por los grants, pero la tabla no necesita
--    publicarse (el cliente la consulta por REST): fuera = una capa menos.
-- 2. Revocar grants de escritura sobre `registros_jugadores` (PII). RLS sin
--    políticas ya los bloquea; revocar es cinturón y tirantes.
-- 3. Tope de jugadores por sala (200): evita que alguien con el PIN llene la
--    sala con miles de filas. Invisible para una fiesta real.
-- 4. Validación de icono/color en unirse_sala (longitud + charset). Los
--    valores salen de la lista del cliente; si un cliente los manda raros,
--    se sustituyen por los defaults en vez de rechazar (cero fricción).
-- 5. Tope de salas por anfitrión (50): anti-abuso del panel; un host real
--    nunca llega.
-- =============================================================================

-- 1. La tabla del banco (con respuestas) fuera de Realtime.
do $$
begin
  if exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'preguntas'
  ) then
    alter publication supabase_realtime drop table public.preguntas;
  end if;
end $$;

-- 2. PII: solo operaciones via RPC (RLS sin políticas ya lo garantiza).
revoke insert, update, delete, truncate on public.registros_jugadores from anon, authenticated;

-- 3+4. unirse_sala: tope de sala + saneo de icono/color.
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
  v_token text;
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

  -- Anti-abuso: la sala tiene capacidad finita (una fiesta real no llega).
  if (select count(*) from public.jugadores where id_sala = v_sala.id) >= 200 then
    raise exception 'La sala está llena (máximo 200 jugadores)' using errcode = 'P0001';
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

  -- Icono/color: valores de la lista del cliente. Si un cliente manda otra
  -- cosa (muy larga, con símbolos raros), se usa el default: sin rechazo.
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

    insert into public.registros_jugadores (id_jugador, nickname, nombre, apellido, telefono, correo)
    values (v_jugador.id, v_nick, v_nombre, v_apellido, v_telefono, v_correo);

    insert into public.sesiones_jugador (id_jugador) values (v_jugador.id);
  exception when unique_violation then
    raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
  end;

  select token into v_token from public.sesiones_jugador where id_jugador = v_jugador.id;

  return jsonb_build_object(
    'idSala', v_sala.id,
    'codigo', v_sala.codigo,
    'estado', v_sala.estado,
    'juegoActual', v_sala.juego_actual,
    'idJugador', v_jugador.id,
    'nickname', v_jugador.nickname,
    'token', v_token
  );
end;
$$;

-- 5. crear_sala: tope de salas por anfitrión (mis_salas lista 50).
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
  if v_uid is null then
    raise exception 'Debés iniciar sesión como anfitrión' using errcode = '42501';
  end if;

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
