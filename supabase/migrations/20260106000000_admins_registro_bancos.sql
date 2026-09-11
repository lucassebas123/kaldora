-- =============================================================================
-- KALDORA v2.1 — Seguridad de admins, registro de jugadores y CRUD de bancos
-- =============================================================================
-- 1. ADMINISTRADORES CERRADOS:
--    * Tabla `admins_autorizados`: quién manda. El DUEÑO (bootstrap con el
--      email del dueño del proyecto) es el único que gestiona al resto.
--    * Todos los RPCs de anfitrión exigen pertenecer a `admins_autorizados`.
--    * Trigger en auth.users: cada usuario creado desde el dashboard del
--      proyecto se registra solo como `operador` (con "Allow new users to
--      sign up" apagado, la ÚNICA forma de crear cuentas es el dashboard:
--      nadie se auto-registra desde kaldora.site/admin/login).
-- 2. REGISTRO OBLIGATORIO DE JUGADORES (nombre, apellido, celular, correo):
--    * Datos PII en tabla `registros_jugadores` 100% privada (sin políticas,
--      sin permisos, fuera de Realtime) para que nunca se filtren.
-- 3. CRUD de bancos de preguntas (rosco/trivia/supervivencia) para el panel:
--    upsert individual + borrado. La carga masiva usa `cargar_banco`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Administradores autorizados
-- -----------------------------------------------------------------------------
create table if not exists public.admins_autorizados (
  id        uuid primary key references auth.users(id) on delete cascade,
  email     text not null,
  rol       text not null default 'operador' check (rol in ('dueño', 'operador')),
  creado_en timestamptz not null default now()
);

alter table public.admins_autorizados enable row level security;

revoke all privileges on public.admins_autorizados from anon, authenticated;
grant select on public.admins_autorizados to authenticated;

create policy "admins: lectura para anfitriones" on public.admins_autorizados
  for select to authenticated using (true);

-- Helper: ¿el usuario logueado pertenece al equipo de anfitriones?
create or replace function public.es_anfitrion_autorizado()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from public.admins_autorizados where id = auth.uid());
$$;

-- Bootstrap: el dueño del proyecto (creado antes de esta migración).
insert into public.admins_autorizados (id, email, rol)
select u.id, u.email, 'dueño'
  from auth.users u
 where u.email = 'lucassebastiancorreadarre@gmail.com'
on conflict (id) do update set rol = 'dueño', email = excluded.email;

-- Auto-registro: todo usuario creado desde el dashboard entra como operador.
create or replace function public.registrar_admin_automatico()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admins_autorizados (id, email, rol)
  values (new.id, new.email, 'operador')
  on conflict (id) do nothing;
  return new;
exception when others then
  -- Jamás bloquear la creación del usuario por un fallo del registro.
  return new;
end;
$$;

drop trigger if exists trg_admin_automatico on auth.users;
create trigger trg_admin_automatico
  after insert on auth.users
  for each row execute function public.registrar_admin_automatico();

-- -----------------------------------------------------------------------------
-- Rejilla: TODOS los RPCs de anfitrión exigen admin autorizado
-- -----------------------------------------------------------------------------

-- Helper interno: eleva error si no es admin (lo usan los RPCs host).
create or replace function public.exigir_admin()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or not public.es_anfitrion_autorizado() then
    raise exception 'Solo el equipo de anfitriones puede hacer esto' using errcode = '42501';
  end if;
end;
$$;

-- El guardián principal: dueño/admin de la sala específica.
create or replace function public.sala_del_anfitrion(p_sala uuid)
returns public.salas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sala public.salas;
begin
  if v_uid is null or not public.es_anfitrion_autorizado() then
    raise exception 'Solo el equipo de anfitriones puede hacer esto' using errcode = '42501';
  end if;

  select * into v_sala from public.salas where id = p_sala and id_anfitrion = v_uid;
  if not found then
    -- Los operadores pueden gestionar cualquier sala del proyecto (equipo).
    select * into v_sala from public.salas where id = p_sala;
  end if;
  if not found then
    raise exception 'Sala inexistente' using errcode = '42501';
  end if;

  return v_sala;
end;
$$;

-- crear_sala / mis_salas / cargar_banco: también exigen admin.
create or replace function public.crear_sala()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text;
  v_sala public.salas;
  v_intento int;
begin
  perform public.exigir_admin();

  for v_intento in 1..10 loop
    v_codigo := to_char(floor(random() * 900000 + 100000)::int, 'FM000000');
    begin
      insert into public.salas (codigo, id_anfitrion)
      values (v_codigo, auth.uid())
      returning * into v_sala;
      return jsonb_build_object('id', v_sala.id, 'codigo', v_sala.codigo);
    exception when unique_violation then
      null;
    end;
  end loop;

  raise exception 'No se pudo generar un PIN único' using errcode = 'P0001';
end;
$$;

create or replace function public.mis_salas()
returns table (id uuid, codigo text, estado text, juego_actual text, creado_en timestamptz)
language sql
security definer
set search_path = public
as $$
  select s.id, s.codigo, s.estado, s.juego_actual::text, s.creado_en
    from public.salas s
   where public.es_anfitrion_autorizado()
   order by s.creado_en desc
   limit 50;
$$;

-- -----------------------------------------------------------------------------
-- 2. Registro obligatorio de jugadores (PII en tabla privada)
-- -----------------------------------------------------------------------------
create table if not exists public.registros_jugadores (
  id_jugador uuid primary key references public.jugadores(id) on delete cascade,
  nombre     text not null,
  apellido   text not null,
  telefono   text not null,
  correo     text not null,
  creado_en  timestamptz not null default now()
);

alter table public.registros_jugadores enable row level security;
-- Sin políticas y sin permisos: nadie la lee por la API. Privada total.

drop function if exists public.unirse_sala(text, text, text, text);
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

  begin
    insert into public.jugadores (id_sala, nickname, icono, color)
    values (v_sala.id, v_nick, p_icono, p_color)
    returning * into v_jugador;

    insert into public.registros_jugadores (id_jugador, nombre, apellido, telefono, correo)
    values (v_jugador.id, v_nombre, v_apellido, v_telefono, v_correo);

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

-- -----------------------------------------------------------------------------
-- 3. CRUD de bancos de preguntas (solo admins)
-- -----------------------------------------------------------------------------

-- Rosco: upsert por letra (una pregunta activa por letra; pueden coexistir
-- varias y el juego elige una al azar; el upsert por ID edita la elegida).
create or replace function public.guardar_pregunta_rosco(
  p_letra text,
  p_pregunta text,
  p_respuesta text,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letra text := upper(btrim(p_letra));
  v_pregunta text := btrim(p_pregunta);
  v_respuesta text := btrim(p_respuesta);
  v_id uuid;
begin
  perform public.exigir_admin();

  if v_letra !~ '^[A-ZÑ]$' then
    raise exception 'Letra inválida' using errcode = 'P0001';
  end if;
  if v_pregunta = '' or v_respuesta = '' then
    raise exception 'Pregunta y respuesta son obligatorias' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas (letra, pregunta, respuesta)
    values (v_letra, v_pregunta, v_respuesta)
    returning id into v_id;
  else
    update public.preguntas
       set letra = v_letra, pregunta = v_pregunta, respuesta = v_respuesta
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La pregunta ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.guardar_pregunta_trivia(
  p_pregunta text,
  p_opciones jsonb,
  p_indice int,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pregunta text := btrim(p_pregunta);
  v_opciones text[];
  v_id uuid;
begin
  perform public.exigir_admin();

  if jsonb_typeof(p_opciones) <> 'array' or jsonb_array_length(p_opciones) not between 2 and 4 then
    raise exception 'Deben ser entre 2 y 4 opciones' using errcode = 'P0001';
  end if;
  select array_agg(x) from jsonb_array_elements_text(p_opciones) x into v_opciones;
  if v_pregunta = '' then
    raise exception 'La pregunta es obligatoria' using errcode = 'P0001';
  end if;
  if p_indice not between 0 and cardinality(v_opciones) - 1 then
    raise exception 'El índice de la opción correcta no corresponde' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas_trivia (pregunta, opciones, indice_correcto)
    values (v_pregunta, v_opciones, p_indice)
    returning id into v_id;
  else
    update public.preguntas_trivia
       set pregunta = v_pregunta, opciones = v_opciones, indice_correcto = p_indice
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La pregunta ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.guardar_pregunta_supervivencia(
  p_pregunta text,
  p_es_verdadera boolean,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.exigir_admin();
  if btrim(p_pregunta) = '' then
    raise exception 'La frase es obligatoria' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas_supervivencia (pregunta, es_verdadera)
    values (btrim(p_pregunta), p_es_verdadera)
    returning id into v_id;
  else
    update public.preguntas_supervivencia
       set pregunta = btrim(p_pregunta), es_verdadera = p_es_verdadera
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La frase ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.borrar_pregunta(p_banco text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.exigir_admin();

  case p_banco
    when 'rosco' then delete from public.preguntas where id = p_id;
    when 'trivia' then delete from public.preguntas_trivia where id = p_id;
    when 'supervivencia' then delete from public.preguntas_supervivencia where id = p_id;
    else raise exception 'Banco desconocido' using errcode = 'P0001';
  end case;
end;
$$;

-- -----------------------------------------------------------------------------
-- Permisos
-- -----------------------------------------------------------------------------
revoke all on function public.exigir_admin() from public, anon, authenticated;
revoke all on function public.es_anfitrion_autorizado() from public, anon, authenticated;
revoke all on function public.registrar_admin_automatico() from public, anon, authenticated;

drop function if exists public.unirse_sala(text, text, text, text);
grant execute on function public.unirse_sala(text, text, text, text, text, text, text, text) to anon, authenticated;

grant execute on function public.guardar_pregunta_rosco(text, text, text, uuid) to authenticated;
grant execute on function public.guardar_pregunta_trivia(text, jsonb, int, uuid) to authenticated;
grant execute on function public.guardar_pregunta_supervivencia(text, boolean, uuid) to authenticated;
grant execute on function public.borrar_pregunta(text, uuid) to authenticated;
