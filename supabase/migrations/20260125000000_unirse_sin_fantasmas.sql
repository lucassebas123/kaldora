-- =============================================================================
-- UNIRSE SIN FANTASMAS — re-registro en la MISMA sala reutiliza la fila
-- =============================================================================
-- Hallazgo del E2E: una cuenta recurrente que se registraba de nuevo en la
-- misma sala (mismo correo/celular) creaba una SEGUNDA fila de jugador: la
-- cuenta quedaba ligada a la nueva y la vieja quedaba de fantasma en el lobby
-- (podía incluso volver a "entrar" con el token viejo).
--
-- Ahora, si la cuenta vigente ya tiene fila en esa sala, se reutiliza:
--   * se actualizan nickname/avatar con lo que eligió el jugador,
--   * se le renueva el token de sesión (la sesión vieja muere),
--   * se actualiza su fila vigente de registros (sin rotar historial).
-- El resto del flujo queda igual (PIN, capacity, validaciones, rate limit).
-- =============================================================================

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

  -- SIN FANTASMAS: la cuenta ya tiene fila en ESTA sala → se reutiliza.
  if v_recurrente and v_cuenta.id_jugador is not null then
    select * into v_jugador
      from public.jugadores
     where id = v_cuenta.id_jugador and id_sala = v_sala.id;

    if found then
      begin
        update public.jugadores
           set nickname = v_nick, icono = v_icono, color = v_color
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

  begin
    insert into public.jugadores (id_sala, nickname, icono, color)
    values (v_sala.id, v_nick, v_icono, v_color)
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
