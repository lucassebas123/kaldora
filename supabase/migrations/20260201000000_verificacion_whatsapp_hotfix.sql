-- =============================================================================
-- HOTFIX — `entrar_con_identificador` conserva el anti fuerza bruta
-- =============================================================================
-- La migración 31 (verificación de WhatsApp) recreó
-- `entrar_con_identificador` sobre la versión de la migración 18 y perdió el
-- endurecimiento de la 24: el rate limit `login_fallos` y los errores
-- "suaves" que commitean el intento. Hallazgo de `scripts/test-seguridad.mjs`
-- (el bloqueo por IP nunca llegaba).
--
-- Se recrea la versión vigente (migración 24) con los mismos campos de
-- verificación que agrega la 31: `verificado`, `codigoVerificacion` y
-- `whatsapp`. `create or replace` conserva los permisos.
-- =============================================================================

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
  -- Anti fuerza bruta del PIN JUG-###### / correo / celular.
  perform public.verificar_limite('login_fallos', 25, interval '5 minutes');

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

  if v_ident is null or char_length(v_ident) < 3 or char_length(v_ident) > 120 then
    raise exception 'Ingresá tu correo, celular o PIN de jugador' using errcode = 'P0001';
  end if;

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
    perform public.registrar_intento('login_fallos');
    return jsonb_build_object(
      'error',
      'No encontramos tu registro. Revisá el dato o volvé con "Regístrate aquí".'
    );
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
