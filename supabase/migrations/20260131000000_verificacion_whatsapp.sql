-- =============================================================================
-- VERIFICACIÓN DE WHATSAPP — gratis, con confirmación del anfitrión
-- =============================================================================
-- Objetivo de producto: que el celular (y el correo) que deja cada jugador
-- "sirvan de algo" y no se puedan inventar. No hay proveedor pago ni API de
-- WhatsApp: el jugador manda un código por WhatsApp AL ANFITRION de su sala
-- (link wa.me prellenado, gratis) y el anfitrión confirma desde la vista
-- privada de su celular (PII solo ahí, nunca en la pantalla proyectada).
--
-- Diseño:
--   * `salas.contacto_whatsapp`: número que recibe los códigos de ESA sala
--     (editable por el anfitrión; sin él, el cliente cae a la variable de
--     entorno VITE_WHATSAPP_ANFITRION). Nunca se expone a `anon` por columna:
--     los jugadores lo reciben vía RPC (`estado_verificacion`).
--   * `registros_jugadores.codigo_verificacion` (privado): código de 6 dígitos
--     generado por el servidor. `verificado`/`verificado_en` marcan la
--     confirmación del anfitrión. Una persona ya verificada hereda el estado
--     al re-registrarse en otra sala.
--   * `jugadores.verificado` (columna pública): espejo liviano para que el
--     badge viaje por Realtime/polling al jugador y a la TV (contador + ✅,
--     sin PII).
--   * RPCs del anfitrión (`verificaciones_pendientes`, `confirmar_verificacion`,
--     `actualizar_contacto_whatsapp`): solo el dueño de la sala; los datos
--     personales viven en la respuesta de `verificaciones_pendientes`, que se
--     consume únicamente desde `/admin/sala/:id/verificaciones` (celular).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Esquema
-- -----------------------------------------------------------------------------
alter table public.salas
  add column if not exists contacto_whatsapp text;

alter table public.jugadores
  add column if not exists verificado boolean not null default false;

alter table public.registros_jugadores
  add column if not exists codigo_verificacion text,
  add column if not exists verificado boolean not null default false,
  add column if not exists verificado_en timestamptz;

-- Columna pública nueva (el resto de los grants por columna quedan intactos).
grant select (verificado) on public.jugadores to anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. Helpers internos (sin execute para clientes)
-- -----------------------------------------------------------------------------
-- Código de 6 dígitos con bytes aleatorios del servidor (no random()).
create or replace function public.generar_codigo_verificacion()
returns text
language sql
volatile
set search_path = public, extensions
as $$
  select lpad(
    ((get_byte(v_b, 0) * 65536 + get_byte(v_b, 1) * 256 + get_byte(v_b, 2)) % 1000000)::text,
    6, '0')
  from (select extensions.gen_random_bytes(3) as v_b) s;
$$;

-- Código libre entre los pendientes de ESA sala (para que el anfitrión no
-- vea dos jugadores con el mismo número en la lista).
create or replace function public.codigo_verificacion_unico(p_sala uuid)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_codigo text;
begin
  for v_intento in 1..50 loop
    v_codigo := public.generar_codigo_verificacion();
    if not exists (
      select 1
        from public.registros_jugadores r
        join public.jugadores j on j.id = r.id_jugador
       where j.id_sala = p_sala
         and not r.verificado
         and r.codigo_verificacion = v_codigo
    ) then
      return v_codigo;
    end if;
  end loop;
  return v_codigo; -- colisión extrema: el host igual compara el número emisor
end;
$$;

revoke all on function public.generar_codigo_verificacion() from public, anon, authenticated;
revoke all on function public.codigo_verificacion_unico(uuid) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. unirse_sala: devuelve el código de verificación + WhatsApp de la sala
--    (base: migración 25, sin fantasmas).
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
  v_verificado boolean := false;
  v_codigo text;
  v_nick text := btrim(p_nickname);
  v_nombre text := btrim(p_nombre);
  v_apellido text := btrim(p_apellido);
  v_telefono text := btrim(p_telefono);
  v_correo text := btrim(p_correo);
  v_icono text := btrim(p_icono);
  v_color text := btrim(p_color);
begin
  perform public.verificar_limite('pin_fallos', 60, interval '5 minutes');

  select * into v_sala from public.salas where codigo = btrim(p_codigo);
  if not found then
    perform public.registrar_intento('pin_fallos');
    return jsonb_build_object('error', 'No existe una sala con ese PIN');
  end if;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La partida ya empezó. Pedile al anfitrión que vuelva al lobby' using errcode = 'P0001';
  end if;

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

  if v_icono !~ '^[A-Za-z][A-Za-z0-9]{0,39}$' then
    v_icono := 'Star';
  end if;
  if v_color !~ '^[a-zA-Z0-9\-]{1,60}$' then
    v_color := 'bg-purple-500';
  end if;

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

  -- Verificación de WhatsApp: se hereda de la cuenta vigente (una persona ya
  -- verificada no vuelve a verificar en otra sala).
  if v_recurrente then
    v_verificado := coalesce(v_cuenta.verificado, false);
    v_codigo := v_cuenta.codigo_verificacion;
  end if;
  if v_verificado then
    v_codigo := null;
  elsif v_codigo is null then
    v_codigo := public.codigo_verificacion_unico(v_sala.id);
  end if;

  -- SIN FANTASMAS: la cuenta ya tiene fila en ESTA sala → se reutiliza.
  if v_recurrente and v_cuenta.id_jugador is not null then
    select * into v_jugador
      from public.jugadores
     where id = v_cuenta.id_jugador and id_sala = v_sala.id;

    if found then
      begin
        update public.jugadores
           set nickname = v_nick, icono = v_icono, color = v_color,
               verificado = v_verificado
         where id = v_jugador.id
         returning * into v_jugador;
      exception when unique_violation then
        raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
      end;

      -- Token nuevo: la sesión anterior de ese dispositivo queda invalidada.
      delete from public.sesiones_jugador where id_jugador = v_jugador.id;
      insert into public.sesiones_jugador (id_jugador)
      values (v_jugador.id)
      returning token into v_token;

      -- La identidad sigue siendo la misma cuenta vigente (sin rotar).
      update public.registros_jugadores
         set id_jugador = v_jugador.id,
             nickname = v_nick,
             nombre = v_nombre,
             apellido = v_apellido,
             telefono = v_telefono,
             verificado = v_verificado,
             codigo_verificacion = v_codigo,
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
        'recurrente', true,
        'verificado', v_verificado,
        'codigoVerificacion', v_codigo,
        'whatsapp', v_sala.contacto_whatsapp
      );
    end if;
  end if;

  begin
    insert into public.jugadores (id_sala, nickname, icono, color, verificado)
    values (v_sala.id, v_nick, v_icono, v_color, v_verificado)
    returning * into v_jugador;

    insert into public.sesiones_jugador (id_jugador) values (v_jugador.id);
  exception when unique_violation then
    raise exception 'Ese nickname ya está en uso en esta sala' using errcode = '23505';
  end;

  if v_recurrente then
    update public.registros_jugadores set vigente = false where id = v_cuenta.id;
  end if;

  begin
    insert into public.registros_jugadores
      (id_jugador, nickname, nombre, apellido, telefono, correo,
       pin_jugador, vigente, ultimo_acceso, verificado, codigo_verificacion)
    values
      (v_jugador.id, v_nick, v_nombre, v_apellido, v_telefono, v_correo,
       v_pin, true, now(), v_verificado, v_codigo);
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
    'recurrente', v_recurrente,
    'verificado', v_verificado,
    'codigoVerificacion', v_codigo,
    'whatsapp', v_sala.contacto_whatsapp
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. entrar_con_identificador: propaga el estado de verificación
--    (base: migración 18, cupo recién al crear fila nueva).
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
  v_verificado boolean := false;
  v_codigo text;
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

  -- Verificación heredada de la cuenta (ya verificada o pendiente).
  v_verificado := coalesce(v_cuenta.verificado, false);
  v_codigo := v_cuenta.codigo_verificacion;
  if v_verificado then
    v_codigo := null;
  elsif v_codigo is null then
    v_codigo := public.codigo_verificacion_unico(v_sala.id);
    update public.registros_jugadores set codigo_verificacion = v_codigo where id = v_cuenta.id;
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

      update public.jugadores
         set verificado = v_verificado
       where id = v_jugador.id;

      update public.registros_jugadores
         set id_jugador = v_jugador.id,
             verificado = v_verificado,
             codigo_verificacion = v_codigo,
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
        'recurrente', true,
        'verificado', v_verificado,
        'codigoVerificacion', v_codigo,
        'whatsapp', v_sala.contacto_whatsapp
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
    insert into public.jugadores (id_sala, nickname, icono, color, verificado)
    values (v_sala.id, v_nick, v_icono, v_color, v_verificado)
    returning * into v_jugador;
  exception when unique_violation then
    raise exception 'Ese nombre se está usando en esta sala. Reintentá en unos segundos.' using errcode = '23505';
  end;

  insert into public.sesiones_jugador (id_jugador)
  values (v_jugador.id)
  returning token into v_token;

  update public.registros_jugadores
     set id_jugador = v_jugador.id,
         verificado = v_verificado,
         codigo_verificacion = v_codigo,
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
    'recurrente', true,
    'verificado', v_verificado,
    'codigoVerificacion', v_codigo,
    'whatsapp', v_sala.contacto_whatsapp
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Estado de verificación del propio jugador (para la sala de espera)
-- -----------------------------------------------------------------------------
create or replace function public.estado_verificacion(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
  v_reg public.registros_jugadores;
begin
  v_jugador := public.jugador_por_token(p_token);

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if not found then
    raise exception 'La sala no existe' using errcode = 'P0001';
  end if;

  select * into v_reg
    from public.registros_jugadores
   where vigente and id_jugador = v_jugador.id
   order by creado_en desc
   limit 1;

  return jsonb_build_object(
    'verificado', v_jugador.verificado,
    'codigo', case when v_jugador.verificado then null else v_reg.codigo_verificacion end,
    'whatsapp', v_sala.contacto_whatsapp,
    'nickname', v_jugador.nickname
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 6. RPCs del anfitrión (vista privada: PII solo acá)
-- -----------------------------------------------------------------------------
-- Pendientes + estado + WhatsApp configurado. Solo el dueño de la sala.
create or replace function public.verificaciones_pendientes(p_sala uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_pendientes jsonb;
  v_total int;
  v_verificados int;
begin
  v_sala := public.sala_del_anfitrion(p_sala);

  select count(*), count(*) filter (where j.verificado)
    into v_total, v_verificados
    from public.jugadores j
   where j.id_sala = p_sala;

  select coalesce(jsonb_agg(jsonb_build_object(
           'idJugador', j.id,
           'nickname', j.nickname,
           'nombre', coalesce(r.nombre, ''),
           'telefono', coalesce(r.telefono, ''),
           'codigo', coalesce(r.codigo_verificacion, '')
         ) order by j.creado_en), '[]'::jsonb)
    into v_pendientes
    from public.jugadores j
    left join lateral (
      select r.nombre, r.telefono, r.codigo_verificacion
        from public.registros_jugadores r
       where r.vigente and r.id_jugador = j.id
       order by r.creado_en desc
       limit 1
    ) r on true
   where j.id_sala = p_sala and not j.verificado;

  return jsonb_build_object(
    'whatsapp', v_sala.contacto_whatsapp,
    'pendientes', v_pendientes,
    'total', v_total,
    'verificados', v_verificados
  );
end;
$$;

create or replace function public.confirmar_verificacion(p_sala uuid, p_jugador uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);

  update public.jugadores
     set verificado = true
   where id = p_jugador and id_sala = p_sala;
  if not found then
    raise exception 'Ese jugador no está en la sala' using errcode = 'P0001';
  end if;

  update public.registros_jugadores
     set verificado = true,
         verificado_en = now(),
         codigo_verificacion = null
   where id = (
     select id from public.registros_jugadores
      where vigente and id_jugador = p_jugador
      order by creado_en desc
      limit 1
   );

  return jsonb_build_object('ok', true, 'idJugador', p_jugador);
end;
$$;

create or replace function public.actualizar_contacto_whatsapp(p_sala uuid, p_whatsapp text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_num text := btrim(coalesce(p_whatsapp, ''));
begin
  perform public.sala_del_anfitrion(p_sala);

  if v_num <> '' and v_num !~ '^\+?[0-9 ()-]{6,20}$' then
    raise exception 'Ingresá un número de WhatsApp válido (ej: +54 9 11 5555-1234)' using errcode = 'P0001';
  end if;

  update public.salas
     set contacto_whatsapp = nullif(v_num, '')
   where id = p_sala;

  return jsonb_build_object('ok', true, 'whatsapp', nullif(v_num, ''));
end;
$$;

-- -----------------------------------------------------------------------------
-- 7. Permisos
-- -----------------------------------------------------------------------------
grant execute on function public.estado_verificacion(text) to anon, authenticated;
grant execute on function public.verificaciones_pendientes(uuid) to authenticated;
grant execute on function public.confirmar_verificacion(uuid, uuid) to authenticated;
grant execute on function public.actualizar_contacto_whatsapp(uuid, text) to authenticated;
