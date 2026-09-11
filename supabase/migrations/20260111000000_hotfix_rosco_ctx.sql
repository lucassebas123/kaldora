-- =============================================================================
-- HOTFIX — rosco_ctx: pregunta_id text (el operador ->> devuelve texto).
-- =============================================================================
-- Contexto del rosco para un jugador (estado + ventana temporal válida).
drop function if exists public.rosco_ctx(text);
create function public.rosco_ctx(p_token text)
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
  v_duracion := coalesce((v_sala.juego ->> 'duracion_ms')::numeric, 150000);

  return query select v_sala.id, v_jugador.id,
    v_jugador.rosco ->> 'l',
    v_jugador.rosco ->> 'q',
    coalesce(v_jugador.rosco -> 'e', '{}'::jsonb),
    coalesce((v_jugador.rosco ->> 't')::boolean, false),
    v_transcurrido <= v_duracion + 2500;
end;
$$;

-- Avanza al siguiente pendiente (o cierra el rosco del jugador). Interior:
-- fija la pregunta de la nueva letra; las letras sin banco se marcan 4
-- (sin_pregunta) y se saltean hasta encontrar una con pregunta.
create or replace function public.rosco_avanzar_interno(
  p_jugador_id uuid,
  p_estados jsonb,
  p_desde text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letra text;
  v_estados jsonb := p_estados;
  v_pregunta_id uuid;
  v_intentos int := 0;
begin
  loop
    v_letra := public.rosco_letra_siguiente(v_estados, p_desde);

    if v_letra is null then
      -- No quedan pendientes: rosco terminado para este jugador.
      update public.jugadores
         set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null)
       where id = p_jugador_id;
      return false;
    end if;

    select public.elegir_pregunta_letra(v_letra) into v_pregunta_id;

    if v_pregunta_id is not null then
      update public.jugadores
         set rosco = jsonb_build_object('l', v_letra, 'q', v_pregunta_id, 'e', v_estados, 't', false)
       where id = p_jugador_id;
      return true;
    end if;

    -- Sin pregunta para esta letra: queda 4 (sin_pregunta) y se continúa.
    v_estados := jsonb_set(v_estados, array[v_letra], '4', true);
    p_desde := v_letra;
    v_intentos := v_intentos + 1;
    exit when v_intentos > 27;
  end loop;

  update public.jugadores
     set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null)
   where id = p_jugador_id;
  return false;
end;
$$;


