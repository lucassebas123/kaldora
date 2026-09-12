-- =============================================================================
-- KALDORA v2 — Portal de juegos multijugador en tiempo real
-- =============================================================================
-- Evolución del backend de "El Rosco" a una plataforma de 4 juegos masivos:
--   * rosco        -> Rosco sincronizado: todos responden cada letra en 15 s,
--                     +100 por acierto, -50 por error (validación en servidor).
--   * trivia       -> Trivia de velocidad: 1000 pts base que decrecen ms a ms
--                     durante 20 s, multiplicadores por racha (x2 / x3).
--   * basta        -> Tutti Frutti: 5 categorías; el primero en completar
--                     dispara una cuenta regresiva letal de 10 s. Palabras
--                     únicas valen 10, repetidas 5.
--   * supervivencia-> V/F a eliminación súbita: un error (o no responder)
--                     elimina al jugador y lo convierte en espectador.
--
-- Pilares de seguridad:
--   * El ANFITRIÓN es un usuario de Supabase Auth (rol `authenticated`).
--     Cada sala queda ligada a su `auth.uid()`; los RPCs de host validan
--     `auth.uid() = salas.id_anfitrion`. Nada de tokens de host compartidos.
--   * El JUGADOR es anon con un token secreto generado por el servidor
--     (misma técnica de la v1) que autentica cada acción de juego.
--   * RLS estricta + permisos a nivel de COLUMNA: las respuestas correctas
--     (preguntas.respuesta, indice_correcto, es_verdadera) NUNCA viajan al
--     cliente anon. Toda escritura pasa por RPCs SECURITY DEFINER.
--   * Realtime: publicación de salas, jugadores, rosco_respuestas,
--     respuestas_basta y supervivencia_respuestas. El tráfico masivo
--     (cada respuesta, aviso de "¡completé Basta!") viaja por BROADCAST del
--     canal de la sala, sin escribir la base.
--
-- Re-aplicación segura: el archivo destruye el esquema v1 (equipos/turnos) y
-- deja la v2 limpia. `supabase db push` lo aplica una sola vez.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Extensiones
-- -----------------------------------------------------------------------------
create extension if not exists pgcrypto;
create extension if not exists unaccent;
create extension if not exists fuzzystrmatch;

-- -----------------------------------------------------------------------------
-- Limpieza total del esquema v1 (tablas, funciones y políticas obsoletas)
-- -----------------------------------------------------------------------------
drop table if exists public.anfitriones cascade;
drop table if exists public.equipos cascade;
drop table if exists public.jugadores cascade;

drop function if exists public.validar_cupo_equipo() cascade;
drop function if exists public.letras_rosco() cascade;
drop function if exists public.siguiente_letra_pendiente(jsonb, text) cascade;
drop function if exists public.proximo_equipo_id(uuid, uuid, jsonb, int) cascade;
drop function if exists public.tiempo_restante_actual(public.salas, public.equipos) cascade;
drop function if exists public.estado_con_letra(jsonb, text, text) cascade;
drop function if exists public.sala_por_host(uuid, text) cascade;
drop function if exists public.jugador_por_token(text) cascade;
drop function if exists public.procesar_fin_turno(uuid, uuid, jsonb, boolean, int) cascade;
drop function if exists public.aplicar_acierto_equipo(uuid, uuid, boolean, boolean) cascade;
drop function if exists public.aplicar_fallo_equipo(uuid, uuid, boolean, boolean) cascade;
drop function if exists public.marcar_pasapalabra_equipo(uuid, uuid) cascade;
drop function if exists public.crear_sala() cascade;
drop function if exists public.retomar_sala_anfitrion(uuid, text) cascade;
drop function if exists public.iniciar_partida(uuid, text) cascade;
drop function if exists public.anfitrion_pasar_turno(uuid, text, uuid) cascade;
drop function if exists public.pausar_partida(uuid, text) cascade;
drop function if exists public.reanudar_partida(uuid, text) cascade;
drop function if exists public.terminar_partida(uuid, text) cascade;
drop function if exists public.volver_al_lobby(uuid, text) cascade;
drop function if exists public.anfitrion_marcar_acierto(uuid, text) cascade;
drop function if exists public.anfitrion_corregir_acierto(uuid, text) cascade;
drop function if exists public.anfitrion_marcar_fallo(uuid, text) cascade;
drop function if exists public.anfitrion_forzar_fallo(uuid, text) cascade;
drop function if exists public.guardar_pregunta(uuid, text, uuid, text, text, text) cascade;
drop function if exists public.cargar_preguntas_masivo(uuid, text, jsonb) cascade;
drop function if exists public.registrar_jugador(uuid, text, text, text, text) cascade;
drop function if exists public.crear_equipo(text, text, text, text, text) cascade;
drop function if exists public.unirse_a_pareja(text, uuid) cascade;
drop function if exists public.listar_parejas_con_cupo(uuid) cascade;
drop function if exists public.jugador_marcar_acierto(text) cascade;
drop function if exists public.jugador_marcar_fallo(text) cascade;
drop function if exists public.jugador_pasapalabra(text) cascade;
drop function if exists public.jugador_enviar_respuesta_pendiente(text, text) cascade;

-- -----------------------------------------------------------------------------
-- Tipos
-- -----------------------------------------------------------------------------
create type public.juego_tipo as enum ('rosco', 'trivia', 'basta', 'supervivencia');

-- -----------------------------------------------------------------------------
-- Tabla maestra: salas (dueño = usuario de Supabase Auth)
-- -----------------------------------------------------------------------------
drop table if exists public.salas cascade;
create table public.salas (
  id            uuid primary key default gen_random_uuid(),
  codigo        text not null unique check (codigo ~ '^[0-9]{6}$'),
  id_anfitrion  uuid not null references auth.users(id) on delete cascade,
  estado        text not null default 'en_espera'
                check (estado in ('en_espera', 'jugando', 'pausado', 'finalizado')),
  juego_actual  public.juego_tipo,
  -- Estado volátil del juego en curso (letra activa, pregunta_id, inicio de
  -- ronda, deadline letal del Basta, etc.). Un solo jsonb = un solo evento
  -- Realtime por transición, sin tormenta de writes.
  juego         jsonb not null default '{}'::jsonb,
  creado_en     timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Jugadores (anon). Sin PII y SIN secretos: el token de sesión vive en su
-- propia tabla privada ('sesiones_jugador') porque Realtime transmite la fila
-- completa por WAL a los suscriptores autorizados: nada secreto puede
-- publicarse dentro de 'jugadores'.
-- -----------------------------------------------------------------------------
create table public.jugadores (
  id         uuid primary key default gen_random_uuid(),
  id_sala    uuid not null references public.salas(id) on delete cascade,
  nickname   text not null check (char_length(btrim(nickname)) between 1 and 20),
  icono      text not null default 'Star',
  color      text not null default 'bg-purple-500',
  puntos     int not null default 0 check (puntos >= 0),
  racha      int not null default 0 check (racha >= 0),
  eliminado  boolean not null default false,
  creado_en  timestamptz not null default now()
);

create index idx_jugadores_sala on public.jugadores(id_sala);
-- Nickname único por sala (sin tildes/espacios de más, insensible a mayúsculas).
create unique index uq_jugadores_nickname
  on public.jugadores (id_sala, lower(btrim(nickname)));

-- Sesión secreta del jugador (autenticación de sus RPCs). Tabla 100% privada:
-- sin políticas RLS y sin permisos para clientes.
create table public.sesiones_jugador (
  id_jugador uuid primary key references public.jugadores(id) on delete cascade,
  token      text not null unique default encode(extensions.gen_random_bytes(16), 'hex'),
  creado_en  timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Respuestas del Rosco (una por jugador y letra)
-- -----------------------------------------------------------------------------
create table public.rosco_respuestas (
  id          uuid primary key default gen_random_uuid(),
  id_sala     uuid not null references public.salas(id) on delete cascade,
  id_jugador  uuid not null references public.jugadores(id) on delete cascade,
  letra       text not null check (letra ~ '^[A-ZÑ]$'),
  correcta    boolean not null,
  puntos      int not null,
  creado_en   timestamptz not null default now(),
  constraint uq_rosco_una_por_letra unique (id_jugador, letra)
);

create index idx_rosco_respuestas_sala on public.rosco_respuestas(id_sala, letra);

-- -----------------------------------------------------------------------------
-- Banco de Trivia de velocidad
-- -----------------------------------------------------------------------------
create table public.preguntas_trivia (
  id              uuid primary key default gen_random_uuid(),
  pregunta        text not null,
  opciones        text[] not null check (cardinality(opciones) between 2 and 4),
  indice_correcto int not null check (indice_correcto between 0 and 3),
  creado_en       timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Respuestas de Trivia (una por jugador y pregunta; auditoría + contadores)
-- -----------------------------------------------------------------------------
create table public.trivia_respuestas (
  id          uuid primary key default gen_random_uuid(),
  id_sala     uuid not null references public.salas(id) on delete cascade,
  id_jugador  uuid not null references public.jugadores(id) on delete cascade,
  id_pregunta uuid not null references public.preguntas_trivia(id) on delete cascade,
  opcion      int not null,
  correcta    boolean not null,
  puntos      int not null default 0,
  creado_en   timestamptz not null default now(),
  constraint uq_trivia_una_por_pregunta unique (id_jugador, id_pregunta)
);

create index idx_trivia_respuestas_sala on public.trivia_respuestas(id_sala, id_pregunta);

-- -----------------------------------------------------------------------------
-- Basta / Tutti Frutti
-- -----------------------------------------------------------------------------
create table public.categorias_basta (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null unique,
  creado_en timestamptz not null default now()
);

create table public.respuestas_basta (
  id           uuid primary key default gen_random_uuid(),
  id_sala      uuid not null references public.salas(id) on delete cascade,
  id_jugador   uuid not null references public.jugadores(id) on delete cascade,
  id_categoria uuid not null references public.categorias_basta(id) on delete cascade,
  texto        text not null default '',
  valida       boolean not null default true,
  unico        boolean,
  puntos       int not null default 0,
  creado_en    timestamptz not null default now(),
  constraint uq_basta_una_por_categoria unique (id_jugador, id_categoria)
);

create index idx_basta_respuestas_sala on public.respuestas_basta(id_sala);

-- -----------------------------------------------------------------------------
-- Banco de Supervivencia (Verdadero / Falso)
-- -----------------------------------------------------------------------------
create table public.preguntas_supervivencia (
  id           uuid primary key default gen_random_uuid(),
  pregunta     text not null,
  es_verdadera boolean not null,
  creado_en    timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Respuestas de Supervivencia (auditoría de rondas)
-- -----------------------------------------------------------------------------
create table public.supervivencia_respuestas (
  id          uuid primary key default gen_random_uuid(),
  id_sala     uuid not null references public.salas(id) on delete cascade,
  id_jugador  uuid not null references public.jugadores(id) on delete cascade,
  id_pregunta uuid not null references public.preguntas_supervivencia(id) on delete cascade,
  respuesta   boolean not null,
  correcta    boolean not null,
  creado_en   timestamptz not null default now(),
  constraint uq_supervivencia_una_por_pregunta unique (id_jugador, id_pregunta)
);

create index idx_supervivencia_respuestas_sala on public.supervivencia_respuestas(id_sala, id_pregunta);

-- =============================================================================
-- Funciones internas (sin execute para clientes)
-- =============================================================================

-- Las 27 letras del rosco en orden fijo (con Ñ).
create or replace function public.letras_rosco()
returns text[]
language sql
immutable
as $$
  select array['A','B','C','D','E','F','G','H','I','J','K','L','M','N','Ñ',
               'O','P','Q','R','S','T','U','V','W','X','Y','Z']::text[];
$$;

-- Normalización server-side de palabras (idéntico al criterio del cliente v1):
-- sin tildes, minúsculas, sin puntuación, espacios colapsados.
create or replace function public.normalizar_palabra(p_texto text)
returns text
language sql
immutable
set search_path = public, extensions
as $$
  select btrim(regexp_replace(
           regexp_replace(unaccent(lower(btrim(p_texto))),
                          '[.,;:!?¡¿"''()\-]', ' ', 'g'),
           '\s+', ' ', 'g'));
$$;

-- Autentica a la sala del anfitrión logueado. Eleva error si no es dueño.
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
  if v_uid is null then
    raise exception 'Debés iniciar sesión como anfitrión' using errcode = '42501';
  end if;

  select * into v_sala from public.salas where id = p_sala and id_anfitrion = v_uid;
  if not found then
    raise exception 'Sala inexistente o no sos su anfitrión' using errcode = '42501';
  end if;

  return v_sala;
end;
$$;

-- Autentica un token de jugador y devuelve su fila.
create or replace function public.jugador_por_token(p_token text)
returns public.jugadores
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
begin
  select j.* into v_jugador
    from public.jugadores j
    join public.sesiones_jugador s on s.id_jugador = j.id
   where s.token = p_token;
  if not found then
    raise exception 'Sesión de jugador inválida' using errcode = 'P0001';
  end if;
  return v_jugador;
end;
$$;

-- Devuelve (sala, jugador, juego) frescos y verifica que la sala esté
-- jugando X juego. SIN lock: los RPCs que mutan 'salas' toman su propio
-- lock para no serializar las respuestas masivas de todos los jugadores.
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
  if v_sala.juego_actual <> p_juego then
    raise exception 'El juego activo no corresponde' using errcode = 'P0001';
  end if;

  return query select v_sala.id, v_jugador.id, v_sala.juego;
end;
$$;

-- Suma (o resta, con piso en 0) puntos a un jugador.
create or replace function public.sumar_puntos(p_jugador uuid, p_delta int)
returns void
language sql
security definer
set search_path = public
as $$
  update public.jugadores
     set puntos = greatest(0, puntos + p_delta)
   where id = p_jugador;
$$;

-- Elige un id de pregunta al azar (pueden pedir excluir la actual).
create or replace function public.elegir_pregunta_trivia(p_excluir uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from public.preguntas_trivia
   where id <> coalesce(p_excluir, '00000000-0000-0000-0000-000000000000'::uuid)
   order by random()
   limit 1;
$$;

create or replace function public.elegir_pregunta_supervivencia(p_excluir uuid)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from public.preguntas_supervivencia
   where id <> coalesce(p_excluir, '00000000-0000-0000-0000-000000000000'::uuid)
   order by random()
   limit 1;
$$;

-- Desplaza los relojes del juego al reanudar una pausa: todo lo que esté
-- fechado en el futuro (inicio de letra/pregunta, deadline letal) corre
-- exactamente lo que duró la pausa.
create or replace function public.reanudar_relojes(p_juego jsonb)
returns jsonb
language plpgsql
volatile
as $$
declare
  v_desplazamiento interval;
  v_claves text[] := array['letra_inicio', 'inicio', 'deadline'];
  v_clave text;
  v_juego jsonb := p_juego;
begin
  if not (v_juego ? 'pausa_en') then
    return v_juego;
  end if;

  v_desplazamiento := clock_timestamp() - (v_juego ->> 'pausa_en')::timestamptz;

  foreach v_clave in array v_claves loop
    if v_juego ? v_clave and (v_juego -> v_clave) is not null then
      v_juego := jsonb_set(
        v_juego,
        array[v_clave],
        to_jsonb((v_juego ->> v_clave)::timestamptz + v_desplazamiento)
      );
    end if;
  end loop;

  return v_juego - 'pausa_en';
end;
$$;

-- =============================================================================
-- RPC de sala y lobby
-- =============================================================================

-- Crea una sala para el anfitrión logueado. PIN con reintentos ante colisión.
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

-- Salas del anfitrión logueado (dashboard admin).
create or replace function public.mis_salas()
returns table (id uuid, codigo text, estado text, juego_actual text, creado_en timestamptz)
language sql
security definer
set search_path = public
as $$
  select s.id,
         s.codigo,
         s.estado,
         s.juego_actual::text,
         s.creado_en
    from public.salas s
   where s.id_anfitrion = auth.uid()
   order by s.creado_en desc
   limit 50;
$$;

-- Borra una sala propia (y todo lo colgante).
create or replace function public.borrar_sala(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);
  delete from public.salas where id = p_sala;
end;
$$;

-- El jugador (anon) entra con PIN + nickname. Devuelve su sesión completa.
create or replace function public.unirse_sala(
  p_codigo text,
  p_nickname text,
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

  begin
    insert into public.jugadores (id_sala, nickname, icono, color)
    values (v_sala.id, v_nick, p_icono, p_color)
    returning * into v_jugador;

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

-- El jugador abandona la sala (borra su fila y su presencia).
create or replace function public.salir_sala(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
begin
  v_jugador := public.jugador_por_token(p_token);
  delete from public.jugadores where id = v_jugador.id;
end;
$$;

-- El anfitrión elige el próximo juego (lobby muestra el preview).
create or replace function public.seleccionar_juego(p_sala uuid, p_juego text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);

  if p_juego is not null and p_juego not in ('rosco', 'trivia', 'basta', 'supervivencia') then
    raise exception 'Juego desconocido' using errcode = 'P0001';
  end if;

  update public.salas
     set juego_actual = (p_juego::public.juego_tipo),
         juego = '{}'::jsonb
   where id = p_sala;
end;
$$;

-- Chequeo genérico: la sala debe estar 'en_espera' para iniciar.
create or replace function public.validar_arranque(p_sala uuid)
returns public.salas
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
begin
  v_sala := public.sala_del_anfitrion(p_sala);
  if v_sala.estado <> 'en_espera' then
    raise exception 'La sala no está en espera' using errcode = 'P0001';
  end if;
  if v_sala.juego_actual is null then
    raise exception 'Primero elegí un juego' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.jugadores where id_sala = p_sala) then
    raise exception 'No hay jugadores en la sala' using errcode = 'P0001';
  end if;
  return v_sala;
end;
$$;

-- Pausa: congela el estado. Los relojes se reubican al reanudar.
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
  if v_sala.estado <> 'pausado' then return; end if;

  update public.salas
     set estado = 'jugando',
         juego = public.reanudar_relojes(v_sala.juego)
   where id = p_sala;
end;
$$;

-- Termina la partida y muestra el podio en todos los clientes.
create or replace function public.terminar_partida(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);
  update public.salas
     set estado = 'finalizado', juego = '{}'::jsonb
   where id = p_sala;
end;
$$;

-- Revancha: reset total de jugadores y de las tablas de juego.
create or replace function public.volver_al_lobby(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);

  delete from public.rosco_respuestas where id_sala = p_sala;
  delete from public.respuestas_basta where id_sala = p_sala;
  delete from public.supervivencia_respuestas where id_sala = p_sala;

  update public.jugadores
     set puntos = 0, racha = 0, eliminado = false
   where id_sala = p_sala;

  update public.salas
     set estado = 'en_espera', juego_actual = null, juego = '{}'::jsonb
   where id = p_sala;
end;
$$;

-- Expulsar a un jugador del lobby (host).
create or replace function public.expulsar_jugador(p_sala uuid, p_jugador uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);
  delete from public.jugadores where id = p_jugador and id_sala = p_sala;
end;
$$;

-- =============================================================================
-- JUEGO 1 — EL ROSCO (masivo y sincronizado)
-- =============================================================================
-- Todos los jugadores responden LA MISMA letra al mismo tiempo. 15 s por
-- letra. +100 acierto, -50 error (validado en el servidor con normalización
-- + Levenshtein contra la pregunta fijada en salas.juego.pregunta_id).
-- =============================================================================

-- Inicia el rosco desde la letra A.
create or replace function public.rosco_iniciar(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pregunta_id uuid;
begin
  perform public.validar_arranque(p_sala);

  select id into v_pregunta_id
    from public.preguntas
   where letra = 'A'
   order by random()
   limit 1;

  update public.salas
     set estado = 'jugando',
         juego = jsonb_build_object(
           'letra', 'A',
           'letra_inicio', clock_timestamp(),
           'pregunta_id', v_pregunta_id
         )
   where id = p_sala;
end;
$$;

-- Avanza a la próxima letra. El HOST puede avanzar siempre; cualquier cliente
-- puede forzar el auto-avance SOLO si pasaron los 15 s (idempotente vía
-- p_letra_esperada). Si no quedan letras, la partida termina.
create or replace function public.rosco_avanzar(p_sala uuid, p_letra_esperada text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sala public.salas;
  v_letras text[] := public.letras_rosco();
  v_idx int;
  v_proxima text;
  v_pregunta_id uuid;
  v_es_host boolean;
  v_transcurrido numeric;
begin
  select * into v_sala from public.salas where id = p_sala for update;
  if not found then return; end if;
  if v_sala.estado <> 'jugando' or v_sala.juego_actual <> 'rosco' then return; end if;

  -- Idempotencia: si la letra activa ya no es la esperada, no hacer nada.
  if coalesce(v_sala.juego ->> 'letra', '') <> coalesce(p_letra_esperada, '') then
    return;
  end if;

  v_es_host := (v_uid is not null and v_uid = v_sala.id_anfitrion);

  if not v_es_host then
    v_transcurrido := extract(epoch from (clock_timestamp()
                        - (v_sala.juego ->> 'letra_inicio')::timestamptz));
    if v_transcurrido < 15 then
      return; -- nadie puede adelantar la letra antes de tiempo.
    end if;
  end if;

  v_idx := array_position(v_letras, v_sala.juego ->> 'letra');
  if v_idx is null or v_idx >= cardinality(v_letras) then
    -- Última letra completada: podio.
    update public.salas
       set estado = 'finalizado', juego = '{}'::jsonb
     where id = p_sala;
    return;
  end if;

  v_proxima := v_letras[v_idx + 1];
  select id into v_pregunta_id
    from public.preguntas
   where letra = v_proxima
   order by random()
   limit 1;

  update public.salas
     set juego = jsonb_build_object(
           'letra', v_proxima,
           'letra_inicio', clock_timestamp(),
           'pregunta_id', v_pregunta_id
         )
   where id = p_sala;
end;
$$;

-- Respuesta del jugador para la letra activa. Validación íntegra en servidor.
create or replace function public.rosco_enviar_respuesta(
  p_token text,
  p_letra text,
  p_respuesta text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx record;
  v_pregunta record;
  v_correcta boolean;
  v_limpiar text;
  v_valida text;
  v_distancia int;
  v_umbral int;
  v_transcurrido numeric;
  v_puntos int;
begin
  select * into v_ctx from public.juego_activo(p_token, 'rosco');

  if v_ctx.juego ->> 'letra' <> upper(btrim(p_letra)) then
    raise exception 'La letra ya cambió' using errcode = 'P0001';
  end if;

  v_transcurrido := extract(epoch from (clock_timestamp()
                      - (v_ctx.juego ->> 'letra_inicio')::timestamptz));
  if v_transcurrido > 17 then
    raise exception 'Se acabó el tiempo de esta letra' using errcode = 'P0001';
  end if;

  select respuesta into v_pregunta
    from public.preguntas
   where id = (v_ctx.juego ->> 'pregunta_id')::uuid;
  if not found then
    raise exception 'No hay pregunta cargada para esta letra' using errcode = 'P0001';
  end if;

  v_limpiar := public.normalizar_palabra(p_respuesta);
  v_valida := public.normalizar_palabra(v_pregunta.respuesta);

  if v_limpiar = '' then
    v_correcta := false;
  else
    v_distancia := levenshtein(v_limpiar, v_valida);
    v_umbral := greatest(1, floor(char_length(v_valida) / 4.0)::int);
    v_correcta := (v_limpiar = v_valida) or (v_distancia <= v_umbral);
  end if;

  v_puntos := case when v_correcta then 100 else -50 end;

  begin
    insert into public.rosco_respuestas (id_sala, id_jugador, letra, correcta, puntos)
    values (v_ctx.sala_id, v_ctx.jugador_id, upper(btrim(p_letra)), v_correcta, v_puntos);
  exception when unique_violation then
    raise exception 'Ya respondiste esta letra' using errcode = 'P0001';
  end;

  perform public.sumar_puntos(v_ctx.jugador_id, v_puntos);

  return jsonb_build_object('correcta', v_correcta, 'puntos', v_puntos);
end;
$$;

-- Override del anfitrión: re-califica una respuesta ya enviada (validar).
create or replace function public.rosco_corregir(
  p_sala uuid,
  p_id_respuesta uuid,
  p_correcta boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_respuesta public.rosco_respuestas;
  v_delta int;
begin
  perform public.sala_del_anfitrion(p_sala);

  select * into v_respuesta
    from public.rosco_respuestas
   where id = p_id_respuesta and id_sala = p_sala
   for update;
  if not found then return; end if;

  v_delta := (case when p_correcta then 100 else -50 end) - v_respuesta.puntos;

  update public.rosco_respuestas
     set correcta = p_correcta, puntos = case when p_correcta then 100 else -50 end
   where id = p_id_respuesta;

  perform public.sumar_puntos(v_respuesta.id_jugador, v_delta);
end;
$$;

-- =============================================================================
-- JUEGO 2 — TRIVIA DE VELOCIDAD
-- =============================================================================
-- Base 1000 pts que decrece ms a ms durante 20 s (1 pt por cada 20 ms).
-- Multiplicadores por racha previa: 3-4 aciertos seguidos = x2, 5+ = x3.
-- El índice correcto NUNCA sale al cliente anon: se compara en el servidor.
-- =============================================================================

-- Lanza (o cambia a) la próxima pregunta. Host puede fijar duración (ms).
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

-- Respuesta de un jugador. El servidor mide el tiempo con SU reloj (anti-trampa)
-- y calcula: puntos = round(1000 * (1 - transcurrido/duración)) * multiplicador.
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

  select racha into v_racha_previa from public.jugadores where id = v_ctx.jugador_id;
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
     set racha = case when v_correcta then v_racha_previa + 1 else 0 end,
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

-- =============================================================================
-- JUEGO 3 — BASTA / TUTTI FRUTTI
-- =============================================================================
-- Letra común + 5 categorías. El primero en completar las 5 dispara la cuenta
-- regresiva letal de 10 s para todos. Palabra única y válida = 10 pts,
-- repetida y válida = 5, inválida = 0. El host puede tachar palabras antes
-- de cerrar; cerrar es idempotente y recalcula desde el snapshot de la ronda.
-- =============================================================================

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

-- Guarda una palabra (upsert). Rechaza fuera de ventana.
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

  insert into public.respuestas_basta (id_sala, id_jugador, id_categoria, texto)
  values (v_ctx.sala_id, v_ctx.jugador_id, p_id_categoria, btrim(coalesce(p_texto, '')))
  on conflict (id_jugador, id_categoria)
  do update set texto = excluded.texto;

  return jsonb_build_object('ok', true, 'texto', btrim(coalesce(p_texto, '')));
end;
$$;

-- El jugador declara que completó las 5 categorías. El PRIMERO congela el
-- deadline letal de 10 s para todos (los demás corren contra el reloj).
-- La transición de fase es atómica: se re-verifica el modo bajo lock para que
-- dos completos simultáneos no se pisen.
create or replace function public.basta_declarar_completo(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_sala public.salas;
  v_fase text;
  v_soy_primero boolean := false;
  v_completas int;
begin
  select * into v_ctx from public.juego_activo(p_token, 'basta');
  v_fase := v_ctx.juego ->> 'fase';

  select count(*) into v_completas
    from public.respuestas_basta
   where id_jugador = v_ctx.jugador_id
     and btrim(texto) <> ''
     and id_categoria::text in (select c::text from jsonb_array_elements_text(v_ctx.juego -> 'categorias') c);

  if v_completas < 5 then
    raise exception 'Te faltan categorías por completar' using errcode = 'P0001';
  end if;

  if v_fase = 'cuenta_atras' then
    return jsonb_build_object('soyPrimero', false); -- alguien ya disparó el reloj
  elsif v_fase <> 'escribiendo' then
    raise exception 'La ronda ya cerró' using errcode = 'P0001';
  end if;

  -- Transición atómica: lock de la fila y re-chequeo de la fase real.
  select * into v_sala from public.salas where id = v_ctx.sala_id for update;
  if (v_sala.juego ->> 'fase') = 'escribiendo' then
    v_soy_primero := true;
    update public.salas
       set juego = v_sala.juego
             || jsonb_build_object(
                  'fase', 'cuenta_atras',
                  'deadline', clock_timestamp() + interval '10 seconds',
                  'completado_por', v_ctx.jugador_id)
     where id = v_ctx.sala_id;
  end if;

  return jsonb_build_object('soyPrimero', v_soy_primero);
end;
$$;

-- Cierra la ronda y calcula puntos. Idempotente: recalcula todo desde el
-- snapshot 'puntos_base', así el host puede re-cerrar tras tachar palabras.
create or replace function public.basta_cerrar_ronda(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sala public.salas;
  v_jugador record;
  v_puntos_base int;
  v_delta int;
  v_es_host boolean;
begin
  select * into v_sala from public.salas where id = p_sala for update;
  if not found then return; end if;

  v_es_host := (v_uid is not null and v_uid = v_sala.id_anfitrion);

  -- El HOST puede cerrar/recalcular en escribiendo, cuenta_atras o resultados
  -- (idempotente: recalcula desde el snapshot). El resto solo cierra cuando
  -- pasó el deadline letal.
  if v_es_host then
    if coalesce(v_sala.juego ->> 'fase', '') not in ('escribiendo', 'cuenta_atras', 'resultados') then
      return;
    end if;
  else
    if (v_sala.juego ->> 'fase') <> 'cuenta_atras' then return; end if;
    if clock_timestamp() < (v_sala.juego ->> 'deadline')::timestamptz then return; end if;
  end if;

  -- 1. Unicidad: normalizada, misma sala + categoría, entre palabras válidas.
  update public.respuestas_basta r
     set unico = sub.n_iguales = 1
    from (
      select b.id,
             (select count(*)
                from public.respuestas_basta x
               where x.id_sala = b.id_sala
                 and x.id_categoria = b.id_categoria
                 and x.valida
                 and btrim(x.texto) <> ''
                 and public.normalizar_palabra(x.texto)
                     = public.normalizar_palabra(b.texto)
             )::int as n_iguales
        from public.respuestas_basta b
       where b.id_sala = p_sala
    ) sub
   where r.id = sub.id;

  -- 2. Contribución de esta ronda por respuesta (0/5/10).
  update public.respuestas_basta
     set puntos = case
       when valida and btrim(texto) = '' then 0
       when not valida then 0
       when unico then 10
       else 5
     end
   where id_sala = p_sala;

  -- 3. Recalcula el total desde el snapshot de la ronda (idempotente).
  for v_jugador in
    select id from public.jugadores where id_sala = p_sala
  loop
    v_puntos_base := coalesce(
      (v_sala.juego -> 'puntos_base' ->> v_jugador.id::text)::int, 0);
    select coalesce(sum(puntos), 0) into v_delta
      from public.respuestas_basta
     where id_sala = p_sala and id_jugador = v_jugador.id;

    update public.jugadores
       set puntos = greatest(0, v_puntos_base + v_delta)
     where id = v_jugador.id;
  end loop;

  update public.salas
     set juego = jsonb_set(v_sala.juego, '{fase}', '"resultados"')
   where id = p_sala;
end;
$$;

-- El host tacha/valida una palabra (antes de cerrar).
create or replace function public.basta_toggle_valida(
  p_sala uuid,
  p_id_respuesta uuid,
  p_valida boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.sala_del_anfitrion(p_sala);
  update public.respuestas_basta
     set valida = p_valida
   where id = p_id_respuesta and id_sala = p_sala;
end;
$$;

-- =============================================================================
-- JUEGO 4 — SUPERVIVENCIA (V/F, eliminación súbita)
-- =============================================================================
-- Un error (o no responder dentro de la ventana) elimina al jugador: pasa a
-- espectador con la pantalla teñida de rojo. +25 por acierto.
-- =============================================================================

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

create or replace function public.supervivencia_responder(p_token text, p_respuesta boolean)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_jugador public.jugadores;
  v_pregunta record;
  v_correcta boolean;
  v_transcurrido numeric;
begin
  select * into v_ctx from public.juego_activo(p_token, 'supervivencia');

  select * into v_jugador from public.jugadores where id = v_ctx.jugador_id;
  if v_jugador.eliminado then
    raise exception 'Estás eliminado: solo podés mirar' using errcode = 'P0001';
  end if;

  v_transcurrido := extract(epoch from (clock_timestamp() - (v_ctx.juego ->> 'inicio')::timestamptz));
  if v_transcurrido * 1000 > coalesce((v_ctx.juego ->> 'duracion_ms')::int, 10000) + 1500 then
    raise exception 'Se acabó el tiempo de esta ronda' using errcode = 'P0001';
  end if;

  select es_verdadera into v_pregunta
    from public.preguntas_supervivencia
   where id = (v_ctx.juego ->> 'pregunta_id')::uuid;
  if not found then
    raise exception 'La pregunta ya no está activa' using errcode = 'P0001';
  end if;

  v_correcta := (p_respuesta = v_pregunta.es_verdadera);

  begin
    insert into public.supervivencia_respuestas
      (id_sala, id_jugador, id_pregunta, respuesta, correcta)
    values (v_ctx.sala_id, v_ctx.jugador_id, (v_ctx.juego ->> 'pregunta_id')::uuid,
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

-- Procesa el fin de ventana: elimina a los vivos que no respondieron.
-- Idempotente (valida la pregunta esperada).
create or replace function public.supervivencia_procesar(
  p_sala uuid,
  p_pregunta_id_esperada uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_sala public.salas;
  v_es_host boolean;
  v_transcurrido numeric;
begin
  select * into v_sala from public.salas where id = p_sala for update;
  if not found then return; end if;
  if v_sala.estado <> 'jugando' or v_sala.juego_actual <> 'supervivencia' then return; end if;
  if coalesce(v_sala.juego ->> 'pregunta_id', '') <> coalesce(p_pregunta_id_esperada::text, '') then
    return;
  end if;

  v_es_host := (v_uid is not null and v_uid = v_sala.id_anfitrion);
  v_transcurrido := extract(epoch from (clock_timestamp() - (v_sala.juego ->> 'inicio')::timestamptz));

  if not v_es_host and v_transcurrido * 1000 < coalesce((v_sala.juego ->> 'duracion_ms')::int, 10000) then
    return; -- nadie puede eliminar antes de tiempo.
  end if;

  update public.jugadores j
     set eliminado = true
   where j.id_sala = p_sala
     and not j.eliminado
     and not exists (
       select 1 from public.supervivencia_respuestas r
        where r.id_jugador = j.id
          and r.id_pregunta = (v_sala.juego ->> 'pregunta_id')::uuid
     );
end;
$$;

-- =============================================================================
-- BONUS — Carga masiva de preguntas (host logueado), para los 3 bancos
-- =============================================================================
-- Formato por ítem jsonb: { letra|pregunta|respuesta } según juego:
--   rosco: { letra, pregunta, respuesta }
--   trivia: { pregunta, opciones: [...], indice_correcto }
--   supervivencia: { pregunta, es_verdadera }
create or replace function public.cargar_banco(
  p_banco text,
  p_items jsonb
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'Debés iniciar sesión como anfitrión' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Se espera un array de ítems' using errcode = 'P0001';
  end if;

  for v_item in select * from jsonb_array_elements(p_items) loop
    case p_banco
      when 'rosco' then
        if coalesce(v_item ->> 'letra', '') ~ '^[A-ZÑ]$'
           and coalesce(v_item ->> 'pregunta', '') <> ''
           and coalesce(v_item ->> 'respuesta', '') <> '' then
          insert into public.preguntas (letra, pregunta, respuesta)
          values (v_item ->> 'letra', btrim(v_item ->> 'pregunta'), btrim(v_item ->> 'respuesta'));
          v_count := v_count + 1;
        end if;
      when 'trivia' then
        if coalesce(v_item ->> 'pregunta', '') <> ''
           and jsonb_typeof(v_item -> 'opciones') = 'array'
           and jsonb_array_length(v_item -> 'opciones') between 2 and 4
           and coalesce((v_item ->> 'indice_correcto')::int, -1)
               between 0 and coalesce(jsonb_array_length(v_item -> 'opciones'), 0) - 1 then
          insert into public.preguntas_trivia (pregunta, opciones, indice_correcto)
          values (
            btrim(v_item ->> 'pregunta'),
            (select array_agg(x) from jsonb_array_elements_text(v_item -> 'opciones') x),
            (v_item ->> 'indice_correcto')::int
          );
          v_count := v_count + 1;
        end if;
      when 'supervivencia' then
        if coalesce(v_item ->> 'pregunta', '') <> ''
           and jsonb_typeof(v_item -> 'es_verdadera') = 'boolean' then
          insert into public.preguntas_supervivencia (pregunta, es_verdadera)
          values (btrim(v_item ->> 'pregunta'), (v_item -> 'es_verdadera')::boolean);
          v_count := v_count + 1;
        end if;
      else
        raise exception 'Banco desconocido' using errcode = 'P0001';
    end case;
  end loop;

  return v_count;
end;
$$;

-- =============================================================================
-- Row Level Security + permisos por COLUMNA
-- =============================================================================
-- Regla de oro: el cliente anon jamás recibe respuestas correctas, y jamás
-- escribe tablas. Los host (authenticated) leen todo lo de sus salas.

alter table public.salas enable row level security;
alter table public.jugadores enable row level security;
alter table public.sesiones_jugador enable row level security;
alter table public.preguntas enable row level security;
alter table public.preguntas_trivia enable row level security;
alter table public.categorias_basta enable row level security;
alter table public.respuestas_basta enable row level security;
alter table public.preguntas_supervivencia enable row level security;
alter table public.supervivencia_respuestas enable row level security;
alter table public.rosco_respuestas enable row level security;
alter table public.trivia_respuestas enable row level security;

-- Lectura pública de salas (por PIN).
revoke all privileges on public.salas from anon, authenticated;
grant select on public.salas to anon, authenticated;
drop policy if exists "salas: lectura pública" on public.salas;
create policy "salas: lectura pública" on public.salas
  for select to anon, authenticated using (true);

-- Jugadores: solo columnas públicas (token jamás).
revoke all privileges on public.jugadores from anon, authenticated;
grant select (id, id_sala, nickname, icono, color, puntos, racha, eliminado, creado_en)
  on public.jugadores to anon, authenticated;
create policy "jugadores: lectura pública" on public.jugadores
  for select to anon, authenticated using (true);

-- Preguntas del rosco: el anon ve letra y enunciado, JAMÁS la respuesta.
revoke all privileges on public.preguntas from anon, authenticated;
grant select (id, letra, pregunta) on public.preguntas to anon;
grant select (id, letra, pregunta, respuesta) on public.preguntas to authenticated;
-- Idempotencia de recuperación: la tabla `preguntas` sobrevive a la limpieza v1
-- y su política se llama igual. `drop ... if exists` permite reconstruir la
-- base desde cero (v1 + v2) sin romper el replay histórico.
drop policy if exists "preguntas: lectura pública" on public.preguntas;
create policy "preguntas: lectura pública" on public.preguntas
  for select to anon, authenticated using (true);

-- Trivia: sin indice_correcto para anon.
revoke all privileges on public.preguntas_trivia from anon, authenticated;
grant select (id, pregunta, opciones, creado_en) on public.preguntas_trivia to anon;
grant select (id, pregunta, opciones, indice_correcto, creado_en) on public.preguntas_trivia to authenticated;
create policy "trivia: lectura pública" on public.preguntas_trivia
  for select to anon, authenticated using (true);

-- Supervivencia: sin es_verdadera para anon.
revoke all privileges on public.preguntas_supervivencia from anon, authenticated;
grant select (id, pregunta, creado_en) on public.preguntas_supervivencia to anon;
grant select (id, pregunta, es_verdadera, creado_en) on public.preguntas_supervivencia to authenticated;
create policy "supervivencia: lectura pública" on public.preguntas_supervivencia
  for select to anon, authenticated using (true);

-- Categorías del Basta: públicas.
revoke all privileges on public.categorias_basta from anon, authenticated;
grant select on public.categorias_basta to anon, authenticated;
create policy "basta categorias: lectura pública" on public.categorias_basta
  for select to anon, authenticated using (true);

-- Respuestas del rosco: públicas (para contadores y podio).
revoke all privileges on public.rosco_respuestas from anon, authenticated;
grant select (id, id_sala, id_jugador, letra, correcta, puntos, creado_en)
  on public.rosco_respuestas to anon, authenticated;
create policy "rosco respuestas: lectura pública" on public.rosco_respuestas
  for select to anon, authenticated using (true);

-- Palabras del Basta: el anon solo las ve cuando la ronda ya cerró
-- (evita copiarse en vivo). El host siempre ve todo.
revoke all privileges on public.respuestas_basta from anon, authenticated;
grant select (id, id_sala, id_jugador, id_categoria, texto, valida, unico, puntos, creado_en)
  on public.respuestas_basta to anon, authenticated;
create policy "basta palabras: host" on public.respuestas_basta
  for select to authenticated using (true);
create policy "basta palabras: anon al cerrar" on public.respuestas_basta
  for select to anon using (
    exists (
      select 1 from public.salas s
       where s.id = id_sala
         and (s.estado = 'finalizado' or coalesce(s.juego ->> 'fase', '') = 'resultados')
    )
  );

-- Auditoría de supervivencia: el anon ve quién respondió, no qué respondió.
revoke all privileges on public.supervivencia_respuestas from anon, authenticated;
grant select (id, id_sala, id_jugador, id_pregunta, creado_en)
  on public.supervivencia_respuestas to anon, authenticated;
grant select (id, id_sala, id_jugador, id_pregunta, respuesta, correcta, creado_en)
  on public.supervivencia_respuestas to authenticated;
create policy "supervivencia: lectura pública" on public.supervivencia_respuestas
  for select to anon, authenticated using (true);

-- Auditoría de trivia: el anon ve quién respondió, no qué opción eligió.
revoke all privileges on public.trivia_respuestas from anon, authenticated;
grant select (id, id_sala, id_jugador, id_pregunta, creado_en)
  on public.trivia_respuestas to anon, authenticated;
grant select (id, id_sala, id_jugador, id_pregunta, opcion, correcta, puntos, creado_en)
  on public.trivia_respuestas to authenticated;
create policy "trivia: lectura pública" on public.trivia_respuestas
  for select to anon, authenticated using (true);

-- Sesión secreta del jugador: ninguna política, ningún permiso. Privada.
revoke all privileges on public.sesiones_jugador from anon, authenticated;

-- =============================================================================
-- Realtime
-- =============================================================================
-- SOLO se publican salas y jugadores: son las dos tablas 100% libres de
-- secretos. Realtime entrega la fila completa por WAL a los suscriptores con
-- política de lectura: por eso todo lo que contenga respuestas correctas,
-- opciones elegidas o tokens vive FUERA de la publicación (se consulta por
-- REST, que sí respeta los permisos por columna) y los contadores en vivo
-- viajan por BROADCAST.
-- =============================================================================
do $$
declare
  t text;
begin
  foreach t in array array['salas', 'jugadores']
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- =============================================================================
-- Permisos de ejecución de RPCs
-- =============================================================================
grant execute on function public.crear_sala() to authenticated;
grant execute on function public.mis_salas() to authenticated;
grant execute on function public.borrar_sala(uuid) to authenticated;
grant execute on function public.unirse_sala(text, text, text, text) to anon, authenticated;
grant execute on function public.salir_sala(text) to anon, authenticated;
grant execute on function public.seleccionar_juego(uuid, text) to authenticated;
grant execute on function public.pausar_partida(uuid) to authenticated;
grant execute on function public.reanudar_partida(uuid) to authenticated;
grant execute on function public.terminar_partida(uuid) to authenticated;
grant execute on function public.volver_al_lobby(uuid) to authenticated;
grant execute on function public.expulsar_jugador(uuid, uuid) to authenticated;

grant execute on function public.rosco_iniciar(uuid) to authenticated;
grant execute on function public.rosco_avanzar(uuid, text) to anon, authenticated;
grant execute on function public.rosco_enviar_respuesta(text, text, text) to anon, authenticated;
grant execute on function public.rosco_corregir(uuid, uuid, boolean) to authenticated;

grant execute on function public.trivia_siguiente(uuid, int) to authenticated;
grant execute on function public.trivia_responder(text, int) to anon, authenticated;

grant execute on function public.basta_iniciar_ronda(uuid) to authenticated;
grant execute on function public.basta_enviar(text, uuid, text) to anon, authenticated;
grant execute on function public.basta_declarar_completo(text) to anon, authenticated;
grant execute on function public.basta_cerrar_ronda(uuid) to anon, authenticated;
grant execute on function public.basta_toggle_valida(uuid, uuid, boolean) to authenticated;

grant execute on function public.supervivencia_siguiente(uuid, int) to authenticated;
grant execute on function public.supervivencia_responder(text, boolean) to anon, authenticated;
grant execute on function public.supervivencia_procesar(uuid, uuid) to anon, authenticated;

grant execute on function public.cargar_banco(text, jsonb) to authenticated;

-- Helpers internos: sin execute.
revoke all on function public.letras_rosco() from public, anon, authenticated;
revoke all on function public.normalizar_palabra(text) from public, anon, authenticated;
revoke all on function public.sala_del_anfitrion(uuid) from public, anon, authenticated;
revoke all on function public.jugador_por_token(text) from public, anon, authenticated;
revoke all on function public.juego_activo(text, public.juego_tipo) from public, anon, authenticated;
revoke all on function public.sumar_puntos(uuid, int) from public, anon, authenticated;
revoke all on function public.elegir_pregunta_trivia(uuid) from public, anon, authenticated;
revoke all on function public.elegir_pregunta_supervivencia(uuid) from public, anon, authenticated;
revoke all on function public.reanudar_relojes(jsonb) from public, anon, authenticated;
revoke all on function public.validar_arranque(uuid) from public, anon, authenticated;
