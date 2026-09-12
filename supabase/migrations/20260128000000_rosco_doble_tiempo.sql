-- =============================================================================
-- ROSCO — tiempo duplicado (150 s → 300 s por defecto)
-- =============================================================================
-- El reloj total continuo del rosco pasaba rápido para pensar cada letra.
-- Se duplica el valor por defecto (5 minutos) y el techo se mantiene en
-- 20 minutos (1200 s) para duraciones personalizadas.
--
--   * `rosco_iniciar`: default 300 s (antes 150).
--   * `rosco_ctx` y `rosco_estado`: fallback de duración 300000 ms por si el
--     jsonb de la sala llegara sin `duracion_ms`.
--
-- `create or replace` conserva los permisos existentes (internos revocados;
-- `rosco_estado`/`rosco_iniciar` como estaban).
-- =============================================================================

create or replace function public.rosco_iniciar(p_sala uuid, p_duracion_seg int default 300)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_pregunta_id uuid;
  v_duracion int := greatest(60, least(1200, coalesce(p_duracion_seg, 300)));
begin
  perform public.validar_arranque(p_sala);

  update public.jugadores
     set rosco = jsonb_build_object('l', 'A', 'e', '{}'::jsonb, 't', false,
                'q', public.elegir_pregunta_letra('A'))
   where id_sala = p_sala;

  update public.salas
     set estado = 'jugando',
         juego_actual = 'rosco',
         juego = jsonb_build_object(
           'inicio', clock_timestamp(),
           'duracion_ms', v_duracion * 1000
         )
   where id = p_sala;
end;
$$;

-- Contexto del rosco para un jugador (estado + ventana temporal válida).
create or replace function public.rosco_ctx(p_token text)
returns table (sala_id uuid, jugador_id uuid, letra text, pregunta_id text,
               estados jsonb, terminado boolean, tiempo_ok boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_jugador public.jugadores;
  v_sala public.salas;
  v_transcurrido numeric;
  v_duracion numeric;
begin
  v_jugador := public.jugador_por_token(p_token);

  select * into v_sala from public.salas where id = v_jugador.id_sala;
  if not found then
    raise exception 'La sala no existe' using errcode = 'P0001';
  end if;
  if v_sala.estado <> 'jugando' or v_sala.juego_actual <> 'rosco' then
    raise exception 'El rosco no está en curso' using errcode = 'P0001';
  end if;

  v_transcurrido := extract(epoch from (clock_timestamp() - (v_sala.juego ->> 'inicio')::timestamptz)) * 1000;
  v_duracion := coalesce((v_sala.juego ->> 'duracion_ms')::numeric, 300000);

  return query select v_sala.id, v_jugador.id,
    v_jugador.rosco ->> 'l',
    v_jugador.rosco ->> 'q',
    coalesce(v_jugador.rosco -> 'e', '{}'::jsonb),
    coalesce((v_jugador.rosco ->> 't')::boolean, false),
    v_transcurrido <= v_duracion + 2500;
end;
$$;

-- Estado completo del rosco propio (para restaurar tras una recarga).
create or replace function public.rosco_estado(p_token text)
returns jsonb
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

  return jsonb_build_object(
    'rosco', coalesce(v_jugador.rosco, '{}'::jsonb),
    'inicio', v_sala.juego ->> 'inicio',
    'duracion_ms', coalesce((v_sala.juego ->> 'duracion_ms')::int, 300000)
  );
end;
$$;
