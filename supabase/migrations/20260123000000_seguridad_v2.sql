-- =============================================================================
-- SEGURIDAD v2 — anti fuerza bruta, PII mínima, topes de entrada y columnas
-- =============================================================================
-- 1. RATE LIMIT POR IP sobre los CAMINOS DE FALLO (no sobre los éxitos):
--    un evento real tiene 20-60 celulares detrás del MISMO IP público (NAT
--    del Wi-Fi): limitar TODOS los intentos dejaría gente afuera. Se cuentan
--    solo los PIN/identificadores que NO existen, que es justo el patrón de
--    un ataque de enumeración.
--    La IP sale del header x-forwarded-for que PostgREST expone en
--    `request.headers`; si no está, se agrupa como 'ip-desconocida'.
--
-- 2. `perfil_por_correo` deja de devolver apellido y teléfono: cualquiera
--    podía probar correos y cosechar PII. Ahora solo `existe`, `nombre` y
--    `nickname` (lo justo para saludar en el registro).
--
-- 3. Topes defensivos de entrada: palabra de Basta y respuesta de Rosco
--    ≤ 60 caracteres; opción de Trivia dentro del rango real (0-3).
--
-- 4. `salas`: el rol anon deja de ver `id_anfitrion` (grant por columna).
--    Realtime entrega la fila sin esa columna (mismo mecanismo que ya usa
--    `preguntas` para esconder la respuesta correcta).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Infraestructura del rate limit
-- -----------------------------------------------------------------------------
create table if not exists public.intentos_acceso (
  id        bigserial primary key,
  ip        text not null,
  accion    text not null,
  creado_en timestamptz not null default now()
);

create index if not exists idx_intentos_acceso
  on public.intentos_acceso (accion, ip, creado_en desc);

alter table public.intentos_acceso enable row level security;
revoke all privileges on public.intentos_acceso from anon, authenticated;
revoke all privileges on sequence public.intentos_acceso_id_seq from anon, authenticated;

-- IP del solicitante (PostgREST la publica en request.headers).
create or replace function public.ip_solicitante()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_headers jsonb;
  v_ip text;
begin
  begin
    v_headers := current_setting('request.headers', true)::jsonb;
  exception when others then
    v_headers := null;
  end;
  v_ip := coalesce(v_headers ->> 'x-forwarded-for', '');
  if v_ip = '' then
    return 'ip-desconocida';
  end if;
  -- "cliente, proxy1, proxy2": el primer valor es el cliente real.
  return btrim(split_part(v_ip, ',', 1));
end;
$$;

-- Eleva error si esa IP superó p_max en la ventana. NO registra nada.
create or replace function public.verificar_limite(
  p_accion text,
  p_max int,
  p_ventana interval
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  select count(*) into v_n
    from public.intentos_acceso
   where ip = public.ip_solicitante()
     and accion = p_accion
     and creado_en > clock_timestamp() - p_ventana;

  if v_n >= p_max then
    raise exception 'Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo.'
      using errcode = 'P0001';
  end if;
end;
$$;

-- Registra un fallo (PIN/identificador inexistente) + purga oportunista.
create or replace function public.registrar_intento(p_accion text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.intentos_acceso (ip, accion) values (public.ip_solicitante(), p_accion);

  -- 1 de cada ~50 llamadas limpia lo viejo: la tabla no crece sin control.
  if random() < 0.02 then
    delete from public.intentos_acceso where creado_en < clock_timestamp() - interval '1 day';
  end if;
end;
$$;

revoke all on function public.ip_solicitante() from public, anon, authenticated;
revoke all on function public.verificar_limite(text, int, interval) from public, anon, authenticated;
revoke all on function public.registrar_intento(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. unirse_sala: límite de PINs inexistentes (no bloquea altas legítimas)
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
  -- Anti-enumeración: se cuentan solo los PINs que no existen.
  perform public.verificar_limite('pin_fallos', 60, interval '5 minutes');

  select * into v_sala from public.salas where codigo = btrim(p_codigo);
  if not found then
    perform public.registrar_intento('pin_fallos');
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
-- 3. entrar_con_identificador: límite de identificadores inexistentes
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
  -- Anti fuerza bruta del PIN JUG-###### / correo / celular.
  perform public.verificar_limite('login_fallos', 25, interval '5 minutes');

  select * into v_sala from public.salas where codigo = btrim(p_codigo);
  if not found then
    perform public.registrar_intento('pin_fallos');
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
    perform public.registrar_intento('login_fallos');
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
-- 4. perfil_por_correo: PII mínima + límite de enumeración
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

  -- Tope generoso para uso real (varias consultas mientras se tipea) pero
  -- suficiente para cortar el barrido de correos.
  perform public.verificar_limite('perfil', 300, interval '5 minutes');

  select r.nombre,
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

  -- Privacidad: NO se devuelven apellido ni teléfono. Cualquiera podía probar
  -- un correo y cosechar PII; el saludo y el nickname alcanzan para el UX.
  return jsonb_build_object(
    'existe', true,
    'nombre', v_registro.nombre,
    'nickname', v_registro.nickname
  );
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. Topes de entrada en los juegos
-- -----------------------------------------------------------------------------
-- Basta: la palabra se acota a 60 caracteres ANTES de guardar/validar.
create or replace function public.basta_enviar(
  p_token text,
  p_id_categoria uuid,
  p_texto text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_fase text;
  v_pertenece boolean;
  v_texto text;
begin
  select * into v_ctx from public.juego_activo(p_token, 'basta');
  v_fase := v_ctx.juego ->> 'fase';

  if v_fase = 'cuenta_atras' then
    if clock_timestamp() > (v_ctx.juego ->> 'deadline')::timestamptz + interval '1 second' then
      raise exception 'Se cerró el tiempo para escribir' using errcode = 'P0001';
    end if;
  elsif v_fase <> 'escribiendo' then
    raise exception 'La ronda no acepta palabras' using errcode = 'P0001';
  end if;

  v_pertenece := exists (
    select 1 from jsonb_array_elements_text(v_ctx.juego -> 'categorias') c
     where c::text = p_id_categoria::text
  );
  if not v_pertenece then
    raise exception 'La categoría no pertenece a esta ronda' using errcode = 'P0001';
  end if;

  v_texto := left(btrim(coalesce(p_texto, '')), 60);

  insert into public.respuestas_basta (id_sala, id_jugador, id_categoria, texto)
  values (v_ctx.sala_id, v_ctx.jugador_id, p_id_categoria, v_texto)
  on conflict (id_jugador, id_categoria)
  do update set texto = excluded.texto;

  return jsonb_build_object('ok', true, 'texto', v_texto);
end;
$$;

-- Trivia: la opción elegida debe existir (0-3). Fuera de rango = error.
create or replace function public.trivia_responder(
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

  if p_opcion is null or p_opcion < 0 or p_opcion > 3 then
    raise exception 'Opción inválida' using errcode = 'P0001';
  end if;

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

-- -----------------------------------------------------------------------------
-- 6. salas: anon deja de ver id_anfitrion (grant por columna)
-- -----------------------------------------------------------------------------
revoke select on public.salas from anon;
grant select (id, codigo, estado, juego_actual, juego, creado_en)
  on public.salas to anon;
