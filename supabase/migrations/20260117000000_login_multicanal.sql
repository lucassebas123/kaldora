-- =============================================================================
-- v4 — LOGIN MULTICANAL DEL JUGADOR (correo · celular · PIN de jugador)
-- =============================================================================
-- Problema: entrar a una sala nueva obligaba a registrarse otra vez, y el
-- único modo de reconocer a un recurrente era el correo — justo el dato que
-- más se tipea mal en el celular.
--
-- Solución: `registros_jugadores` pasa de log append-only a HISTORIAL con una
-- sola fila "vigente" por identidad:
--   * `pin_jugador`: código único human-friendly (JUG-######) generado
--     server-side al registrarse; se muestra UNA vez para copiar.
--   * `correo` (case-insensitive) y `celular` (solo dígitos) únicos entre
--     filas vigentes → índices únicos PARCIALES (`where vigente`).
--   * Cada registro rota la fila: la anterior queda como historial (auditoría)
--     y la nueva hereda el mismo PIN. Nada se pierde.
--
-- RPCs:
--   * `unirse_sala` (registro): como siempre + devuelve `pinJugador` y
--     `recurrente`. Sigue siendo el ÚNICO camino que crea cuentas.
--   * `entrar_con_identificador` (login): { GAME PIN + correo|celular|PIN } →
--     encuentra la cuenta vigente, la mete en la sala y devuelve su token.
--     Si la cuenta ya tiene una fila en esa sala, la reutiliza (renueva token)
--     para conservar nickname/avatar/puntos.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Columnas nuevas
-- -----------------------------------------------------------------------------
alter table public.registros_jugadores
  add column if not exists pin_jugador    text,
  add column if not exists vigente        boolean not null default true,
  add column if not exists ultimo_acceso  timestamptz,
  add column if not exists actualizado_en timestamptz not null default now();

-- El PIN tiene formato fijo JUG-###### (integridad).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'registros_pin_formato'
       and conrelid = 'public.registros_jugadores'::regclass
  ) then
    alter table public.registros_jugadores
      add constraint registros_pin_formato
      check (pin_jugador is null or pin_jugador ~ '^JUG-[0-9]{6}$');
  end if;
end $$;

-- -----------------------------------------------------------------------------
-- 2. Helpers internos (sin execute para clientes)
-- -----------------------------------------------------------------------------
-- Celular comparable: solo dígitos (los formatos +54 9 11 ... son ruido).
create or replace function public.normalizar_telefono(p_telefono text)
returns text
language sql
immutable
set search_path = public
as $$
  select regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
$$;

-- PIN de jugador: JUG-###### con bytes aleatorios del servidor (no random()).
create or replace function public.generar_pin_jugador()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select 'JUG-' || lpad(
    ((get_byte(v_b, 0) * 65536 + get_byte(v_b, 1) * 256 + get_byte(v_b, 2)) % 1000000)::text,
    6, '0')
  from (select extensions.gen_random_bytes(3) as v_b) s;
$$;

-- Devuelve un PIN libre entre las filas vigentes (reintenta hasta 50 veces).
create or replace function public.pin_jugador_unico()
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_pin text;
begin
  for v_intento in 1..50 loop
    v_pin := public.generar_pin_jugador();
    if not exists (
      select 1 from public.registros_jugadores
       where vigente and upper(btrim(pin_jugador)) = upper(v_pin)
    ) then
      return v_pin;
    end if;
  end loop;
  raise exception 'No se pudo generar un PIN de jugador único' using errcode = 'P0001';
end;
$$;

revoke all on function public.normalizar_telefono(text) from public, anon, authenticated;
revoke all on function public.generar_pin_jugador() from public, anon, authenticated;
revoke all on function public.pin_jugador_unico() from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Unificación del historial: una sola fila vigente por identidad
-- -----------------------------------------------------------------------------
do $$
declare
  v_id  uuid;
  v_pin text;
begin
  -- 3a. Duplicados por correo: queda vigente el más reciente.
  with ranked as (
    select id, row_number() over (
      partition by lower(btrim(correo)) order by creado_en desc, id desc
    ) as rn
    from public.registros_jugadores
  )
  update public.registros_jugadores r
     set vigente = false
    from ranked
   where r.id = ranked.id and ranked.rn > 1;

  -- 3b. Duplicados por celular (misma normalización que el índice).
  with ranked as (
    select id, row_number() over (
      partition by public.normalizar_telefono(telefono) order by creado_en desc, id desc
    ) as rn
    from public.registros_jugadores
    where vigente
  )
  update public.registros_jugadores r
     set vigente = false
    from ranked
   where r.id = ranked.id and ranked.rn > 1;

  -- 3c. PIN para cada fila vigente que todavía no tenga (reintento por colisión).
  for v_id in
    select id from public.registros_jugadores where vigente and pin_jugador is null
  loop
    loop
      v_pin := public.generar_pin_jugador();
      exit when not exists (
        select 1 from public.registros_jugadores
         where vigente and pin_jugador is not null
           and upper(btrim(pin_jugador)) = upper(v_pin)
      );
    end loop;
    update public.registros_jugadores
       set pin_jugador = v_pin, actualizado_en = now()
     where id = v_id;
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- 4. Unicidad (parcial: solo entre filas vigentes)
-- -----------------------------------------------------------------------------
create unique index if not exists uq_registros_correo_vigente
  on public.registros_jugadores (lower(btrim(correo)))
  where vigente;

create unique index if not exists uq_registros_telefono_vigente
  on public.registros_jugadores (public.normalizar_telefono(telefono))
  where vigente;

create unique index if not exists uq_registros_pin_vigente
  on public.registros_jugadores (upper(btrim(pin_jugador)))
  where vigente;

-- -----------------------------------------------------------------------------
-- 5. Registro (unirse_sala): ahora devuelve el PIN del jugador
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

  begin
    insert into public.jugadores (id_sala, nickname, icono, color)
    values (v_sala.id, v_nick, v_icono, v_color)
    returning * into v_jugador;

    insert into public.sesiones_jugador (id_jugador) values (v_jugador.id);
  exception when unique_violation then
    raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
  end;

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
-- 6. Login multicanal del jugador recurrente
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

  if (select count(*) from public.jugadores where id_sala = v_sala.id) >= 200 then
    raise exception 'La sala está llena (máximo 200 jugadores)' using errcode = 'P0001';
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
-- 7. perfil_por_correo: solo la fila vigente (la identidad actual)
-- -----------------------------------------------------------------------------
create or replace function public.perfil_por_correo(p_correo text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_correo text := btrim(p_correo);
  v_registro record;
begin
  if v_correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('existe', false);
  end if;

  select r.nombre, r.apellido, r.telefono,
         coalesce(nullif(btrim(r.nickname), ''), j.nickname) as nickname
    into v_registro
    from public.registros_jugadores r
    left join public.jugadores j on j.id = r.id_jugador
   where r.vigente = true
     and lower(r.correo) = lower(v_correo)
   limit 1;

  if not found then
    return jsonb_build_object('existe', false);
  end if;

  return jsonb_build_object(
    'existe', true,
    'nombre', v_registro.nombre,
    'apellido', v_registro.apellido,
    'telefono', v_registro.telefono,
    'nickname', v_registro.nickname
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 8. Permisos
-- -----------------------------------------------------------------------------
-- PII: solo vía RPC (RLS sin políticas ya lo garantiza; cinturón y tirantes).
revoke all privileges on public.registros_jugadores from anon, authenticated;

grant execute on function public.unirse_sala(text, text, text, text, text, text, text, text)
  to anon, authenticated;
grant execute on function public.entrar_con_identificador(text, text, text, text)
  to anon, authenticated;
grant execute on function public.perfil_por_correo(text) to anon, authenticated;
