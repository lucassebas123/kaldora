-- =============================================================================
-- El Rosco - Migración inicial: esquema + reglas de negocio + RLS + Realtime
-- =============================================================================
-- Esta migración deja TODA la estructura del backend lista en Supabase:
--   * Tablas: salas, anfitriones, equipos, jugadores, preguntas.
--   * Reglas de negocio (turnos, rueda, cronómetro continuo por equipo) como
--     funciones RPC con SECURITY DEFINER: ningún cliente escribe tablas.
--   * RLS: anon solo LEE salas/equipos/preguntas. Los tokens (anfitrión y
--     jugador) viven en tablas sin exposición y autentican cada acción.
--   * Realtime habilitado para 'salas' y 'equipos'.
--   * Presupuesto de tiempo continuo por equipo: salas.tiempo_turno_segundos
--     (default 300 = 5 min). El reloj corre desde turno_inicio y NO se reinicia
--     por pregunta: solo se congela al ceder el turno o pausar.
--
-- Aplicación: `supabase db push` (o pegar en el SQL Editor del proyecto).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensiones
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.sala_estado as enum ('en_espera', 'jugando', 'pausado', 'finalizado');
create type public.modalidad_equipo as enum ('solo', 'pareja');

-- -----------------------------------------------------------------------------
-- Tablas
-- -----------------------------------------------------------------------------
create table public.salas (
  id                    uuid primary key default gen_random_uuid(),
  codigo                text not null unique check (codigo ~ '^[0-9]{6}$'),
  estado                public.sala_estado not null default 'en_espera',
  id_equipo_actual      uuid, -- FK circular, se agrega tras crear 'equipos'
  turno_inicio          timestamptz,
  tiempo_turno_segundos int not null default 300 check (tiempo_turno_segundos between 30 and 600),
  creado_en             timestamptz not null default now()
);

create table public.equipos (
  id                uuid primary key default gen_random_uuid(),
  id_sala           uuid not null references public.salas(id) on delete cascade,
  nombre_publico    text not null,
  modalidad         public.modalidad_equipo not null default 'solo',
  icono             text not null,
  color             text not null,
  puntos            int not null default 0 check (puntos >= 0),
  errores           int not null default 0 check (errores >= 0),
  tiempo_restante   int not null default 300 check (tiempo_restante between 0 and 3600),
  estado_letras     jsonb not null default '{}'::jsonb,
  letra_actual      text check (letra_actual is null or letra_actual ~ '^[A-ZÑ]$'),
  respuesta_pendiente text,
  creado_en         timestamptz not null default now(),
  constraint uq_equipo_avatar unique (id_sala, icono, color)
);

alter table public.salas
  add constraint fk_salas_equipo_actual
  foreign key (id_equipo_actual) references public.equipos(id) on delete set null;

-- Token del anfitrión: separado de 'salas' para que NUNCA se filtre por
-- Realtime ni por lecturas públicas. Solo lo conocen este módulo y el RPC.
create table public.anfitriones (
  id_sala   uuid primary key references public.salas(id) on delete cascade,
  token     text not null unique,
  creado_en timestamptz not null default now()
);

-- PII privada: la tabla 'jugadores' no tiene políticas de lectura. El token
-- (generado por el servidor) autentica al dispositivo que insertó la fila.
create table public.jugadores (
  id          uuid primary key default gen_random_uuid(),
  id_sala     uuid not null references public.salas(id) on delete cascade,
  id_equipo   uuid references public.equipos(id) on delete set null,
  token       text not null unique default encode(gen_random_bytes(16), 'hex'),
  nombre      text not null,
  apellido    text not null,
  correo      text not null,
  telefono    text not null,
  es_anfitrion boolean not null default false,
  creado_en   timestamptz not null default now()
);

create table public.preguntas (
  id          uuid primary key default gen_random_uuid(),
  letra       text not null check (letra = upper(btrim(letra)) and letra ~ '^[A-ZÑ]$'),
  pregunta    text not null,
  respuesta   text not null,
  creado_en   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Índices
-- -----------------------------------------------------------------------------
create index idx_equipos_sala on public.equipos(id_sala);
create index idx_equipos_sala_creado on public.equipos(id_sala, creado_en, id);
create index idx_jugadores_sala on public.jugadores(id_sala);
create index idx_jugadores_equipo on public.jugadores(id_equipo);
create index idx_preguntas_letra on public.preguntas(letra);

-- -----------------------------------------------------------------------------
-- Trigger: cupo de pareja (máx. 2) y de equipos 'solo' (máx. 1)
-- -----------------------------------------------------------------------------
create or replace function public.validar_cupo_equipo()
returns trigger
language plpgsql
as $$
declare
  v_modalidad public.modalidad_equipo;
  v_cupo int;
begin
  if new.id_equipo is null then
    return new;
  end if;

  select modalidad into v_modalidad from public.equipos where id = new.id_equipo;

  if v_modalidad = 'pareja' then
    select count(*) into v_cupo from public.jugadores where id_equipo = new.id_equipo;
    if v_cupo > 2 then
      raise exception 'La pareja ya tiene 2 miembros' using errcode = 'CUPO2';
    end if;
  else
    if exists (select 1 from public.jugadores where id_equipo = new.id_equipo and id <> new.id) then
      raise exception 'Un equipo modo solo admite un solo jugador' using errcode = 'CUPO1';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_validar_cupo_equipo
  before insert or update of id_equipo on public.jugadores
  for each row execute function public.validar_cupo_equipo();

-- =============================================================================
-- Funciones internas (NO expuestas: se les revoca execute al final)
-- =============================================================================

-- Las 27 letras del rosco en orden fijo.
create or replace function public.letras_rosco()
returns text[]
language sql
immutable
as $$
  select array['A','B','C','D','E','F','G','H','I','J','K','L','M','N','Ñ',
               'O','P','Q','R','S','T','U','V','W','X','Y','Z']::text[];
$$;

-- Próxima letra a preguntar (misma regla que el cliente):
-- 1º letras sin estado o 'pendiente', 2º letras 'pasapalabra', si no -> null.
create or replace function public.siguiente_letra_pendiente(p_estado jsonb, p_letra_actual text)
returns text
language plpgsql
immutable
as $$
declare
  v_letras text[] := public.letras_rosco();
  v_n int := cardinality(v_letras);
  v_idx int := coalesce(array_position(v_letras, p_letra_actual), 0);
  v_paso int;
  v_pos int;
  v_candidata text;
  v_est text;
begin
  for v_paso in 1..v_n loop
    v_pos := ((v_idx - 1 + v_paso) % v_n) + 1;
    v_candidata := v_letras[v_pos];
    v_est := p_estado ->> v_candidata;
    if v_est is null or v_est = 'pendiente' then
      return v_candidata;
    end if;
  end loop;

  for v_paso in 1..v_n loop
    v_pos := ((v_idx - 1 + v_paso) % v_n) + 1;
    v_candidata := v_letras[v_pos];
    if (p_estado ->> v_candidata) = 'pasapalabra' then
      return v_candidata;
    end if;
  end loop;

  return null;
end;
$$;

-- Próximo equipo de la rueda que puede jugar (letras pendientes Y tiempo > 0).
create or replace function public.proximo_equipo_id(
  p_sala_id uuid,
  p_equipo_actual uuid,
  p_estado_saliente jsonb,
  p_restante_saliente int
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_n int;
  v_idx int;
  v_paso int;
  v_pos int;
  v_cand public.equipos;
  v_pendiente boolean;
begin
  select array_agg(e.id order by e.creado_en, e.id) into v_ids
    from public.equipos e
   where e.id_sala = p_sala_id;

  v_n := coalesce(cardinality(v_ids), 0);
  if v_n = 0 then
    return null;
  end if;

  v_idx := coalesce(array_position(v_ids, p_equipo_actual), 0);

  for v_paso in 1..v_n loop
    v_pos := ((v_idx - 1 + v_paso) % v_n) + 1;

    select * into v_cand from public.equipos where id = v_ids[v_pos];

    if v_cand.id = p_equipo_actual then
      v_pendiente := public.siguiente_letra_pendiente(p_estado_saliente, null) is not null;
      if v_pendiente and p_restante_saliente > 0 then
        return v_cand.id;
      end if;
    else
      v_pendiente := public.siguiente_letra_pendiente(v_cand.estado_letras, null) is not null;
      if v_pendiente and coalesce(v_cand.tiempo_restante, 0) > 0 then
        return v_cand.id;
      end if;
    end if;
  end loop;

  return null;
end;
$$;

-- Tiempo restante en vivo: si el equipo está en turno, descuenta el tiempo
-- transcurrido desde turno_inicio (reloj del SERVIDOR). Si no, congelado.
create or replace function public.tiempo_restante_actual(p_sala public.salas, p_equipo public.equipos)
returns int
language sql
stable
as $$
  select case
    when p_sala.id_equipo_actual = p_equipo.id and p_sala.turno_inicio is not null
      then greatest(0, round(p_equipo.tiempo_restante
          - extract(epoch from (clock_timestamp() - p_sala.turno_inicio))::numeric)::int)
    else p_equipo.tiempo_restante
  end;
$$;

-- Marca una letra en el mapa jsonb de estados.
create or replace function public.estado_con_letra(p_estado jsonb, p_letra text, p_valor text)
returns jsonb
language sql
immutable
as $$
  select jsonb_set(coalesce(p_estado, '{}'), array[p_letra], to_jsonb(p_valor::text), true);
$$;

-- Autentica un token de anfitrión para una sala. Eleva error si no coincide.
create or replace function public.sala_por_host(p_sala uuid, p_token text)
returns public.salas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  select s.* into v_sala
    from public.salas s
    join public.anfitriones a on a.id_sala = s.id
   where s.id = p_sala and a.token = p_token;

  if not found then
    raise exception 'Token de anfitrión inválido' using errcode = 'P0001';
  end if;

  return v_sala;
end;
$$;

-- Autentica un token de jugador. Eleva error si no existe.
create or replace function public.jugador_por_token(p_token text)
returns public.jugadores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
begin
  select * into v_jugador from public.jugadores where token = p_token;
  if not found then
    raise exception 'Token de jugador inválido' using errcode = 'P0001';
  end if;
  return v_jugador;
end;
$$;

-- Cierra el turno del equipo activo: congela su tiempo, aplica el flag de
-- error si corresponde, cede el turno al próximo equipo que pueda jugar y,
-- si nadie cumple, finaliza la partida. Transacción unitaria (atómica).
create or replace function public.procesar_fin_turno(
  p_sala_id uuid,
  p_equipo_id uuid,
  p_estado_letras jsonb,
  p_sumar_error boolean default false,
  p_errores_forzado int default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_equipo public.equipos;
  v_restante int;
  v_errores int;
  v_siguiente_id uuid;
  v_siguiente public.equipos;
  v_letra text;
begin
  select * into v_sala from public.salas where id = p_sala_id for update;
  if not found then return; end if;

  select * into v_equipo from public.equipos where id = p_equipo_id for update;
  if not found then return; end if;

  v_restante := public.tiempo_restante_actual(v_sala, v_equipo);
  v_errores := coalesce(p_errores_forzado, case
    when p_sumar_error then coalesce(v_equipo.errores, 0) + 1
    else coalesce(v_equipo.errores, 0)
  end);

  -- Congela el estado + tiempo EXACTO del equipo saliente. Así nunca revivirá
  -- con tiempo completo en su próximo turno (regla crítica del reloj).
  update public.equipos
     set estado_letras = p_estado_letras,
         errores = v_errores,
         tiempo_restante = v_restante,
         respuesta_pendiente = null
   where id = p_equipo_id;

  v_siguiente_id := public.proximo_equipo_id(p_sala_id, p_equipo_id, p_estado_letras, v_restante);

  if v_siguiente_id is null then
    update public.salas
       set estado = 'finalizado', id_equipo_actual = null, turno_inicio = null
     where id = p_sala_id;
    return;
  end if;

  select * into v_siguiente from public.equipos where id = v_siguiente_id;
  v_letra := coalesce(v_siguiente.letra_actual,
                      public.siguiente_letra_pendiente(v_siguiente.estado_letras, null));

  update public.equipos set letra_actual = v_letra where id = v_siguiente_id;
  update public.salas
     set id_equipo_actual = v_siguiente_id, turno_inicio = clock_timestamp()
   where id = p_sala_id;
end;
$$;

-- Marca la letra activa como acierto: +1 punto, avanza de letra SIN cesar el
-- turno (el reloj sigue transcurriendo). Si era la última letra, cede el turno.
create or replace function public.aplicar_acierto_equipo(
  p_sala_id uuid,
  p_equipo_id uuid,
  p_revertir_error boolean default false,
  p_exigir_pendiente boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_equipo public.equipos;
  v_letra text;
  v_est_actual text;
  v_estado jsonb;
  v_siguiente text;
  v_puntos int;
  v_errores int;
begin
  select * into v_equipo from public.equipos where id = p_equipo_id and id_sala = p_sala_id for update;
  if not found then return; end if;

  v_letra := v_equipo.letra_actual;
  if v_letra is null then return; end if;

  v_est_actual := v_equipo.estado_letras ->> v_letra;

  -- Guardia anti doble puntaje: nunca resolver dos veces la MISMA letra.
  if v_est_actual in ('acierto', 'error', 'pasapalabra') and not p_revertir_error then
    raise exception 'La letra % ya fue resuelta', v_letra using errcode = 'P0001';
  end if;
  if p_revertir_error and v_est_actual <> 'error' then
    raise exception 'La letra % no estaba marcada como error', v_letra using errcode = 'P0001';
  end if;
  if p_exigir_pendiente and v_equipo.respuesta_pendiente is null and v_est_actual <> 'error' then
    raise exception 'No hay respuesta pendiente para validar' using errcode = 'P0001';
  end if;

  v_estado := public.estado_con_letra(v_equipo.estado_letras, v_letra, 'acierto');
  v_siguiente := public.siguiente_letra_pendiente(v_estado, v_letra);
  v_puntos := coalesce(v_equipo.puntos, 0) + 1;
  v_errores := case
    when p_revertir_error then greatest(0, coalesce(v_equipo.errores, 0) - 1)
    else coalesce(v_equipo.errores, 0)
  end;

  if v_siguiente is not null then
    update public.equipos
       set puntos = v_puntos,
           errores = v_errores,
           estado_letras = v_estado,
           letra_actual = v_siguiente,
           respuesta_pendiente = null
     where id = v_equipo.id;
  else
    update public.equipos set puntos = v_puntos, errores = v_errores where id = v_equipo.id;
    perform public.procesar_fin_turno(p_sala_id, v_equipo.id, v_estado, false, v_errores);
  end if;
end;
$$;

-- Marca la letra activa como error: +1 error y cede el turno.
--   p_exigir_pendiente=true  -> solo si hay respuesta pendiente (host manual)
--   p_forzar=true            -> convierte un 'acierto' en error (override host)
create or replace function public.aplicar_fallo_equipo(
  p_sala_id uuid,
  p_equipo_id uuid,
  p_exigir_pendiente boolean default false,
  p_forzar boolean default false
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_equipo public.equipos;
  v_letra text;
  v_est_actual text;
  v_estado jsonb;
  v_puntos int;
  v_errores int;
begin
  select * into v_equipo from public.equipos where id = p_equipo_id and id_sala = p_sala_id for update;
  if not found then return; end if;

  v_letra := v_equipo.letra_actual;
  if v_letra is null then return; end if;

  v_est_actual := v_equipo.estado_letras ->> v_letra;

  if p_forzar and v_est_actual = 'acierto' then
    -- Override: el árbitro revierte un acierto mal acordado.
    v_estado := public.estado_con_letra(v_equipo.estado_letras, v_letra, 'error');
    v_puntos := greatest(0, coalesce(v_equipo.puntos, 0) - 1);
    v_errores := coalesce(v_equipo.errores, 0) + 1;
    update public.equipos set puntos = v_puntos, errores = v_errores where id = v_equipo.id;
    perform public.procesar_fin_turno(p_sala_id, v_equipo.id, v_estado, false, v_errores);
    return;
  end if;

  if v_est_actual in ('acierto', 'error', 'pasapalabra') then
    raise exception 'La letra % ya fue resuelta', v_letra using errcode = 'P0001';
  end if;
  if p_exigir_pendiente and v_equipo.respuesta_pendiente is null then
    raise exception 'No hay respuesta pendiente para marcar fallo' using errcode = 'P0001';
  end if;

  v_estado := public.estado_con_letra(v_equipo.estado_letras, v_letra, 'error');
  perform public.procesar_fin_turno(p_sala_id, v_equipo.id, v_estado, true, null);
end;
$$;

-- Pasapalabra: marca la letra y avanza de letra SIN cambiar de turno (el
-- equipo conserva su tiempo, estilo Pasapalabra).
create or replace function public.marcar_pasapalabra_equipo(p_sala_id uuid, p_equipo_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_equipo public.equipos;
  v_letra text;
  v_est_actual text;
  v_estado jsonb;
  v_siguiente text;
begin
  select * into v_equipo from public.equipos where id = p_equipo_id and id_sala = p_sala_id for update;
  if not found then return; end if;

  v_letra := v_equipo.letra_actual;
  if v_letra is null then return; end if;

  v_est_actual := v_equipo.estado_letras ->> v_letra;
  if v_est_actual in ('acierto', 'error', 'pasapalabra') then
    raise exception 'La letra % ya fue resuelta', v_letra using errcode = 'P0001';
  end if;

  v_estado := public.estado_con_letra(v_equipo.estado_letras, v_letra, 'pasapalabra');
  v_siguiente := public.siguiente_letra_pendiente(v_estado, v_letra);

  update public.equipos
     set estado_letras = v_estado,
         letra_actual = v_siguiente,
         respuesta_pendiente = null
   where id = p_equipo_id;
end;
$$;

-- =============================================================================
-- RPC de sala (anfitrión)
-- =============================================================================

-- Crea la sala y devuelve { id, codigo, estado, hostToken, tiempoTurnoSegundos }.
-- Reintenta hasta 10 veces ante colisión de PIN (unique violation se revierte).
create or replace function public.crear_sala()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_codigo text;
  v_sala public.salas;
  v_token text;
  v_intento int;
begin
  for v_intento in 1..10 loop
    v_codigo := to_char(floor(random() * 900000 + 100000)::int, 'FM000000');
    v_token := encode(gen_random_bytes(16), 'hex');

    begin
      insert into public.salas (codigo) values (v_codigo) returning * into v_sala;
      insert into public.anfitriones (id_sala, token) values (v_sala.id, v_token);

      return jsonb_build_object(
        'id', v_sala.id,
        'codigo', v_sala.codigo,
        'estado', v_sala.estado,
        'hostToken', v_token,
        'tiempoTurnoSegundos', v_sala.tiempo_turno_segundos
      );
    exception when unique_violation then
      null; -- PIN repetido: probar otro.
    end;
  end loop;

  raise exception 'No se pudo generar un código de sala único' using errcode = 'P0001';
end;
$$;

-- Reanudación del anfitrión tras un refresh: valida token y devuelve el estado.
create or replace function public.retomar_sala_anfitrion(p_sala uuid, p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  return jsonb_build_object(
    'id', v_sala.id,
    'codigo', v_sala.codigo,
    'estado', v_sala.estado,
    'idEquipoActual', v_sala.id_equipo_actual,
    'tiempoTurnoSegundos', v_sala.tiempo_turno_segundos
  );
end;
$$;

-- Arranca la partida: primer equipo por orden de creación, primera letra
-- pendiente y reloj-sala iniciado (turno_inicio = ahora, reloj del servidor).
create or replace function public.iniciar_partida(p_sala uuid, p_token text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_primer public.equipos;
  v_letra text;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  if v_sala.estado <> 'en_espera' then
    raise exception 'La sala no está en espera' using errcode = 'P0001';
  end if;

  select * into v_primer
    from public.equipos
   where id_sala = p_sala
   order by creado_en, id
   limit 1;

  if not found then
    raise exception 'No hay equipos en la sala' using errcode = 'P0001';
  end if;

  v_letra := public.siguiente_letra_pendiente(v_primer.estado_letras, null);

  update public.equipos set letra_actual = v_letra where id = v_primer.id;
  update public.salas
     set estado = 'jugando', id_equipo_actual = v_primer.id, turno_inicio = clock_timestamp()
   where id = p_sala;

  return v_primer.id;
end;
$$;

-- Cede el turno (host: botón "pasar turno", saltear desconectado o fin de
-- tiempo). Idempotente: si el turno ya avanzó (p_equipo_esperado distinto del
-- actual) no hace nada, evitando dobles pasadas.
create or replace function public.anfitrion_pasar_turno(
  p_sala uuid,
  p_token text,
  p_equipo_esperado uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_equipo public.equipos;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  if v_sala.id_equipo_actual is null or v_sala.id_equipo_actual <> p_equipo_esperado then
    return; -- ya se pasó el turno: no duplicar.
  end if;

  select * into v_equipo from public.equipos where id = v_sala.id_equipo_actual;
  if not found then return; end if;

  perform public.procesar_fin_turno(
    v_sala.id,
    v_equipo.id,
    v_equipo.estado_letras,
    false,
    coalesce(v_equipo.errores, 0)
  );
end;
$$;

-- Pausa: congela el tiempo EXACTO del equipo activo y deja la sala en pausa.
create or replace function public.pausar_partida(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_equipo public.equipos;
  v_restante int;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  if v_sala.estado = 'pausado' or v_sala.id_equipo_actual is null then return; end if;

  select * into v_equipo from public.equipos where id = v_sala.id_equipo_actual for update;
  v_restante := public.tiempo_restante_actual(v_sala, v_equipo);

  update public.equipos set tiempo_restante = v_restante where id = v_equipo.id;
  update public.salas set estado = 'pausado', turno_inicio = null where id = p_sala;
end;
$$;

-- Reanuda: vuelve a 'jugando' y reinicia el reloj desde ahora.
create or replace function public.reanudar_partida(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  if v_sala.estado <> 'pausado' then return; end if;

  update public.salas set estado = 'jugando', turno_inicio = clock_timestamp() where id = p_sala;
end;
$$;

-- Termina la partida al instante y muestra el podio.
create or replace function public.terminar_partida(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_por_host(p_sala, p_token);

  update public.salas
     set estado = 'finalizado', id_equipo_actual = null, turno_inicio = null
   where id = p_sala;
end;
$$;

-- Vuelve al lobby sin expulsar a nadie: resetea letras/puntos/tiempos de todos
-- los equipos y deja la sala recibiendo jugadores.
create or replace function public.volver_al_lobby(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);

  update public.equipos
     set puntos = 0,
         errores = 0,
         tiempo_restante = v_sala.tiempo_turno_segundos,
         estado_letras = '{}'::jsonb,
         letra_actual = null,
         respuesta_pendiente = null
   where id_sala = p_sala;

  update public.salas
     set estado = 'en_espera', id_equipo_actual = null, turno_inicio = null
   where id = p_sala;
end;
$$;

-- =============================================================================
-- RPC de anfitrión: moderación manual (mismas reglas que el jugador)
-- =============================================================================

create or replace function public.anfitrion_marcar_acierto(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);
  if v_sala.id_equipo_actual is null then
    raise exception 'No hay turno activo' using errcode = 'P0001';
  end if;
  -- Exige respuesta pendiente: evita puntajes dobles al validar en vivo.
  perform public.aplicar_acierto_equipo(v_sala.id, v_sala.id_equipo_actual, false, true);
end;
$$;

create or replace function public.anfitrion_corregir_acierto(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);
  if v_sala.id_equipo_actual is null then
    raise exception 'No hay turno activo' using errcode = 'P0001';
  end if;
  perform public.aplicar_acierto_equipo(v_sala.id, v_sala.id_equipo_actual, true, false);
end;
$$;

create or replace function public.anfitrion_marcar_fallo(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);
  if v_sala.id_equipo_actual is null then
    raise exception 'No hay turno activo' using errcode = 'P0001';
  end if;
  perform public.aplicar_fallo_equipo(v_sala.id, v_sala.id_equipo_actual, true, false);
end;
$$;

create or replace function public.anfitrion_forzar_fallo(p_sala uuid, p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_por_host(p_sala, p_token);
  if v_sala.id_equipo_actual is null then
    raise exception 'No hay turno activo' using errcode = 'P0001';
  end if;
  perform public.aplicar_fallo_equipo(v_sala.id, v_sala.id_equipo_actual, false, true);
end;
$$;

-- =============================================================================
-- RPC de jugador
-- =============================================================================

create or replace function public.registrar_jugador(
  p_sala uuid,
  p_nombre text,
  p_apellido text,
  p_correo text,
  p_telefono text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_jugador public.jugadores;
begin
  select * into v_sala from public.salas where id = p_sala;
  if not found then
    raise exception 'La sala no existe' using errcode = 'P0001';
  end if;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La sala ya inició o finalizó la partida' using errcode = 'P0001';
  end if;

  insert into public.jugadores (id_sala, nombre, apellido, correo, telefono, es_anfitrion)
  values (p_sala, btrim(p_nombre), btrim(p_apellido), btrim(p_correo), btrim(p_telefono), false)
  returning * into v_jugador;

  return jsonb_build_object('id', v_jugador.id, 'token', v_jugador.token);
end;
$$;

-- Crea el equipo del jugador, lo enlaza y devuelve su id. La PII nunca se
-- devuelve. El avatar lo valida el constraint uq_equipo_avatar.
create or replace function public.crear_equipo(
  p_token text,
  p_nombre_publico text,
  p_modalidad text,
  p_icono text,
  p_color text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
  v_equipo public.equipos;
  v_nombre text;
  v_modalidad public.modalidad_equipo;
begin
  v_jugador := public.jugador_por_token(p_token);

  if v_jugador.id_equipo is not null then
    raise exception 'Ya tenés un equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La sala ya inició la partida' using errcode = 'P0001';
  end if;

  if p_modalidad not in ('solo', 'pareja') then
    raise exception 'Modalidad inválida' using errcode = 'P0001';
  end if;
  v_modalidad := p_modalidad::public.modalidad_equipo;

  v_nombre := btrim(coalesce(p_nombre_publico, ''));
  if v_nombre = '' then
    raise exception 'El nombre del equipo es obligatorio' using errcode = 'P0001';
  end if;

  begin
    insert into public.equipos (id_sala, nombre_publico, modalidad, icono, color, puntos, errores, tiempo_restante)
    values (v_sala.id, v_nombre, v_modalidad, p_icono, p_color, 0, 0, v_sala.tiempo_turno_segundos)
    returning * into v_equipo;
  exception when unique_violation then
    raise exception 'Esa combinación de ícono y color ya está en uso' using errcode = '23505';
  end;

  update public.jugadores set id_equipo = v_equipo.id where id = v_jugador.id;

  return jsonb_build_object(
    'idEquipo', v_equipo.id,
    'nombrePublico', v_equipo.nombre_publico,
    'modalidad', v_equipo.modalidad::text,
    'tiempoTurnoSegundos', v_sala.tiempo_turno_segundos
  );
end;
$$;

-- Unirse a una pareja con cupo. Bloquea la fila para evitar la carrera de dos
-- jugadores uniéndose a la misma pareja al mismo tiempo.
create or replace function public.unirse_a_pareja(p_token text, p_equipo uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
  v_equipo public.equipos;
  v_cupo int;
begin
  v_jugador := public.jugador_por_token(p_token);

  if v_jugador.id_equipo is not null then
    raise exception 'Ya tenés un equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if v_sala.estado <> 'en_espera' then
    raise exception 'La sala ya inició la partida' using errcode = 'P0001';
  end if;

  select * into v_equipo
    from public.equipos
   where id = p_equipo and id_sala = v_sala.id and modalidad = 'pareja'
   for update;

  if not found then
    raise exception 'La pareja no existe o no está disponible' using errcode = 'P0001';
  end if;

  select count(*) into v_cupo from public.jugadores where id_equipo = p_equipo;
  if v_cupo >= 2 then
    raise exception 'La pareja ya está completa' using errcode = 'CUPO2';
  end if;

  update public.jugadores set id_equipo = p_equipo where id = v_jugador.id;

  return jsonb_build_object('idEquipo', v_equipo.id);
end;
$$;

-- Parejas con lugar libre, para el paso "Unirse a pareja".
create or replace function public.listar_parejas_con_cupo(p_sala uuid)
returns table (id uuid, nombre_publico text, icono text, color text, cupo int)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
    select e.id,
           e.nombre_publico,
           e.icono,
           e.color,
           (2 - (select count(*)::int from public.jugadores j where j.id_equipo = e.id))::int as cupo
      from public.equipos e
     where e.id_sala = p_sala
       and e.modalidad = 'pareja'
       and (select count(*) from public.jugadores j where j.id_equipo = e.id) < 2
     order by e.nombre_publico;
end;
$$;

create or replace function public.jugador_marcar_acierto(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
begin
  v_jugador := public.jugador_por_token(p_token);
  if v_jugador.id_equipo is null then
    raise exception 'No pertenecés a ningún equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala for update;
  if v_sala.estado <> 'jugando' or v_sala.id_equipo_actual <> v_jugador.id_equipo then
    raise exception 'No es tu turno o la partida no está activa' using errcode = 'P0001';
  end if;

  perform public.aplicar_acierto_equipo(v_sala.id, v_jugador.id_equipo, false, false);
end;
$$;

create or replace function public.jugador_marcar_fallo(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
begin
  v_jugador := public.jugador_por_token(p_token);
  if v_jugador.id_equipo is null then
    raise exception 'No pertenecés a ningún equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala for update;
  if v_sala.estado <> 'jugando' or v_sala.id_equipo_actual <> v_jugador.id_equipo then
    raise exception 'No es tu turno o la partida no está activa' using errcode = 'P0001';
  end if;

  perform public.aplicar_fallo_equipo(v_sala.id, v_jugador.id_equipo, false, false);
end;
$$;

create or replace function public.jugador_pasapalabra(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
begin
  v_jugador := public.jugador_por_token(p_token);
  if v_jugador.id_equipo is null then
    raise exception 'No pertenecés a ningún equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala for update;
  if v_sala.estado <> 'jugando' or v_sala.id_equipo_actual <> v_jugador.id_equipo then
    raise exception 'No es tu turno o la partida no está activa' using errcode = 'P0001';
  end if;

  perform public.marcar_pasapalabra_equipo(v_sala.id, v_jugador.id_equipo);
end;
$$;

-- Respaldo manual: cuando no hay pregunta cargada para la letra, la respuesta
-- queda "pendiente" y la valida el anfitrión.
create or replace function public.jugador_enviar_respuesta_pendiente(p_token text, p_respuesta text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
begin
  v_jugador := public.jugador_por_token(p_token);
  if v_jugador.id_equipo is null then
    raise exception 'No pertenecés a ningún equipo' using errcode = 'P0001';
  end if;

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if v_sala.estado <> 'jugando' or v_sala.id_equipo_actual <> v_jugador.id_equipo then
    raise exception 'No es tu turno o la partida no está activa' using errcode = 'P0001';
  end if;

  update public.equipos set respuesta_pendiente = btrim(p_respuesta) where id = v_jugador.id_equipo;
end;
$$;

-- =============================================================================
-- Banco de preguntas (edición exclusiva del anfitrión)
-- =============================================================================

create or replace function public.guardar_pregunta(
  p_sala uuid,
  p_token text,
  p_pregunta_id uuid default null,
  p_letra text default null,
  p_pregunta text default null,
  p_respuesta text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pregunta_id uuid;
  v_letra text;
begin
  -- Valida que sea un anfitrión legítimo (cualquier sala del proyecto).
  perform public.sala_por_host(p_sala, p_token);

  if p_pregunta_id is null then
    v_letra := upper(btrim(p_letra));
    insert into public.preguntas (letra, pregunta, respuesta)
    values (v_letra, btrim(p_pregunta), btrim(p_respuesta))
    returning id into v_pregunta_id;
  else
    update public.preguntas
       set pregunta = btrim(p_pregunta), respuesta = btrim(p_respuesta)
     where id = p_pregunta_id
    returning id into v_pregunta_id;
  end if;

  return v_pregunta_id;
end;
$$;

-- Carga masiva: borra TODO el banco e inserta el lote en una sola transacción
-- (atómico: si algo falla, queda el estado original). Devuelve la cantidad
-- insertada. Formato por ítem: { letra, pregunta, respuesta }.
create or replace function public.cargar_preguntas_masivo(p_sala uuid, p_token text, p_preguntas jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_letra text;
  v_pregunta text;
  v_respuesta text;
  v_count int := 0;
begin
  perform public.sala_por_host(p_sala, p_token);

  if jsonb_typeof(p_preguntas) <> 'array' then
    raise exception 'Se espera un array de preguntas' using errcode = 'P0001';
  end if;

  delete from public.preguntas;

  for v_item in select * from jsonb_array_elements(p_preguntas) loop
    v_letra := upper(btrim(coalesce(v_item ->> 'letra', '')));
    v_pregunta := btrim(coalesce(v_item ->> 'pregunta', ''));
    v_respuesta := btrim(coalesce(v_item ->> 'respuesta', ''));

    if v_letra ~ '^[A-ZÑ]$' and v_pregunta <> '' and v_respuesta <> '' then
      insert into public.preguntas (letra, pregunta, respuesta)
      values (v_letra, v_pregunta, v_respuesta);
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- =============================================================================
-- Row Level Security
-- =============================================================================
-- anon SOLO lee salas/equipos/preguntas (datos públicos de la partida).
-- Toda escritura pasa por las funciones RPC de arriba (SECURITY DEFINER).
-- 'jugadores' (PII) y 'anfitriones' (tokens) no tienen políticas: privadas.

alter table public.salas enable row level security;
alter table public.equipos enable row level security;
alter table public.jugadores enable row level security;
alter table public.preguntas enable row level security;
alter table public.anfitriones enable row level security;

create policy "salas: lectura pública" on public.salas
  for select to anon using (true);

create policy "equipos: lectura pública" on public.equipos
  for select to anon using (true);

create policy "preguntas: lectura pública" on public.preguntas
  for select to anon using (true);

-- =============================================================================
-- Realtime (salas + equipos). 'jugadores' NO se publica (privacidad).
-- =============================================================================
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'salas') then
    alter publication supabase_realtime add table public.salas;
  end if;

  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'equipos') then
    alter publication supabase_realtime add table public.equipos;
  end if;
end $$;

-- =============================================================================
-- Permisos: lecturas públicas + execute de RPC; helpers internos sin execute.
-- =============================================================================
grant usage on schema public to anon, authenticated;
grant select on public.salas, public.equipos, public.preguntas to anon, authenticated;

grant execute on function public.crear_sala() to anon, authenticated;
grant execute on function public.retomar_sala_anfitrion(uuid, text) to anon, authenticated;
grant execute on function public.iniciar_partida(uuid, text) to anon, authenticated;
grant execute on function public.anfitrion_pasar_turno(uuid, text, uuid) to anon, authenticated;
grant execute on function public.pausar_partida(uuid, text) to anon, authenticated;
grant execute on function public.reanudar_partida(uuid, text) to anon, authenticated;
grant execute on function public.terminar_partida(uuid, text) to anon, authenticated;
grant execute on function public.volver_al_lobby(uuid, text) to anon, authenticated;
grant execute on function public.anfitrion_marcar_acierto(uuid, text) to anon, authenticated;
grant execute on function public.anfitrion_corregir_acierto(uuid, text) to anon, authenticated;
grant execute on function public.anfitrion_marcar_fallo(uuid, text) to anon, authenticated;
grant execute on function public.anfitrion_forzar_fallo(uuid, text) to anon, authenticated;
grant execute on function public.guardar_pregunta(uuid, text, uuid, text, text, text) to anon, authenticated;
grant execute on function public.cargar_preguntas_masivo(uuid, text, jsonb) to anon, authenticated;
grant execute on function public.registrar_jugador(uuid, text, text, text, text) to anon, authenticated;
grant execute on function public.crear_equipo(text, text, text, text, text) to anon, authenticated;
grant execute on function public.unirse_a_pareja(text, uuid) to anon, authenticated;
grant execute on function public.listar_parejas_con_cupo(uuid) to anon, authenticated;
grant execute on function public.jugador_marcar_acierto(text) to anon, authenticated;
grant execute on function public.jugador_marcar_fallo(text) to anon, authenticated;
grant execute on function public.jugador_pasapalabra(text) to anon, authenticated;
grant execute on function public.jugador_enviar_respuesta_pendiente(text, text) to anon, authenticated;

-- Los helpers internos no deben ser invocables por los clientes.
revoke all on function public.letras_rosco() from public;
revoke all on function public.siguiente_letra_pendiente(jsonb, text) from public;
revoke all on function public.proximo_equipo_id(uuid, uuid, jsonb, int) from public;
revoke all on function public.tiempo_restante_actual(public.salas, public.equipos) from public;
revoke all on function public.estado_con_letra(jsonb, text, text) from public;
revoke all on function public.sala_por_host(uuid, text) from public;
revoke all on function public.jugador_por_token(text) from public;
revoke all on function public.procesar_fin_turno(uuid, uuid, jsonb, boolean, int) from public;
revoke all on function public.aplicar_acierto_equipo(uuid, uuid, boolean, boolean) from public;
revoke all on function public.aplicar_fallo_equipo(uuid, uuid, boolean, boolean) from public;
revoke all on function public.marcar_pasapalabra_equipo(uuid, uuid) from public;
revoke all on function public.validar_cupo_equipo() from public;

-- =============================================================================
-- Nota de saneamiento: si es necesario re-aplicar este archivo (no recomendado)
-- usar: drop schema public cascade; create schema public;  antes de volverlo
-- a correr.
-- =============================================================================