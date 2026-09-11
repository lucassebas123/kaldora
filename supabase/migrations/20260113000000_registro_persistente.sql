-- =============================================================================
-- HOTFIX — El registro de jugadores SOBREVIVE a la salida y al borrado.
-- =============================================================================
-- Problema: `registros_jugadores` tenía `id_jugador` como PRIMARY KEY con
-- `references jugadores(id) on delete cascade`. La fila del jugador es
-- EFÍMERA (se borra al salir de la sala, al ser expulsado o al borrar la
-- sala), así que el registro con los datos personales (nombre, apellido,
-- celular, correo) desaparecía con ella. Resultado: la tabla de registros
-- quedaba vacía aunque la gente se hubiera registrado.
--
-- Nuevo diseño:
--   * PK propia (`id` uuid) + `id_jugador` nullable con ON DELETE SET NULL:
--     el registro queda como historial independiente del ciclo de la sala.
--   * Columna `nickname` dentro del registro: `perfil_por_correo` puede
--     recuperar el apodo incluso cuando la fila del jugador ya no existe.
--   * `unirse_sala` guarda también el nickname.
--   * `perfil_por_correo` prefiere el nickname propio del registro
--     (retrocompatible con filas viejas vía join a jugadores).
-- =============================================================================

-- 1. Desacoplar el registro del ciclo de vida del jugador.
alter table public.registros_jugadores drop constraint if exists registros_jugadores_pkey;
alter table public.registros_jugadores drop constraint if exists registros_jugadores_id_jugador_fkey;

alter table public.registros_jugadores add column if not exists id uuid;
update public.registros_jugadores set id = gen_random_uuid() where id is null;
alter table public.registros_jugadores alter column id set default gen_random_uuid();
alter table public.registros_jugadores alter column id set not null;
alter table public.registros_jugadores add constraint registros_jugadores_pkey primary key (id);

alter table public.registros_jugadores alter column id_jugador drop not null;
alter table public.registros_jugadores
  add constraint registros_jugadores_id_jugador_fkey
  foreign key (id_jugador) references public.jugadores(id) on delete set null;

-- 2. Nickname dentro del registro (para el perfil por correo).
alter table public.registros_jugadores add column if not exists nickname text not null default '';

-- 3. `unirse_sala` guarda el nickname junto con los datos personales.
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

-- 4. `perfil_por_correo` funciona aunque la fila del jugador ya no exista.
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
   where lower(r.correo) = lower(v_correo)
   order by r.creado_en desc
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
