-- =============================================================================
-- ROSCO — la pregunta de cada letra queda FIJA (pasapalabra sin re-sorteo)
-- =============================================================================
-- Bug: `rosco_avanzar_interno` elegía la pregunta con
-- `elegir_pregunta_letra()` (`order by random()`) CADA VEZ que una letra
-- quedaba activa. Al pasar una letra con pasapalabra y volver por el ciclo de
-- pendientes, la pregunta cambiaba. En el rosco real la pregunta de una letra
-- es la MISMA durante toda la partida: la pensás mientras respondés las demás.
--
-- Fix: el estado del jugador (`jugadores.rosco`) guarda un mapa
-- `p = { "<letra>": "<id_pregunta>" }` que se completa la primera vez que cada
-- letra se muestra y se reutiliza al volver. Solo contiene letras YA
-- presentadas (nunca se filtran preguntas de letras futuras) y las respuestas
-- siguen privadas a nivel de columna.
--
-- `create or replace` conserva los permisos (la función interna sigue sin
-- EXECUTE para clientes).
-- =============================================================================

create or replace function public.rosco_avanzar_interno(
  p_jugador_id uuid,
  p_estados jsonb,
  p_desde text,
  p_delta_puntos int default 0
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letra text;
  v_estados jsonb := p_estados;
  v_preguntas jsonb;
  v_q_actual uuid;
  v_pregunta_id uuid;
  v_intentos int := 0;
begin
  -- Estado actual: mapa de preguntas ya fijadas + la pregunta de la letra en
  -- curso. La letra que se está dejando atrás (p_desde) se siembra en el mapa
  -- para que también quede fija si el jugador la pasó.
  select coalesce(rosco -> 'p', '{}'::jsonb),
         nullif(rosco ->> 'q', '')::uuid
    into v_preguntas, v_q_actual
    from public.jugadores
   where id = p_jugador_id;

  v_preguntas := coalesce(v_preguntas, '{}'::jsonb);

  if v_q_actual is not null and p_desde is not null and not (v_preguntas ? p_desde) then
    v_preguntas := jsonb_set(v_preguntas, array[p_desde], to_jsonb(v_q_actual), true);
  end if;

  loop
    v_letra := public.rosco_letra_siguiente(v_estados, p_desde);

    if v_letra is null then
      -- No quedan pendientes: rosco terminado (estado + puntos en un UPDATE).
      update public.jugadores
         set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null,
                                        'p', v_preguntas),
             puntos = greatest(0, puntos + p_delta_puntos)
       where id = p_jugador_id;
      return false;
    end if;

    -- Pregunta FIJA: si la letra ya se presentó, se reutiliza la misma.
    v_pregunta_id := nullif(v_preguntas ->> v_letra, '')::uuid;

    if v_pregunta_id is null then
      select public.elegir_pregunta_letra(v_letra) into v_pregunta_id;
      if v_pregunta_id is not null then
        v_preguntas := jsonb_set(v_preguntas, array[v_letra], to_jsonb(v_pregunta_id), true);
      end if;
    end if;

    if v_pregunta_id is not null then
      update public.jugadores
         set rosco = jsonb_build_object('l', v_letra, 'q', v_pregunta_id, 'e', v_estados,
                                        't', false, 'p', v_preguntas),
             puntos = greatest(0, puntos + p_delta_puntos)
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
     set rosco = jsonb_build_object('e', v_estados, 't', true, 'l', null, 'q', null,
                                    'p', v_preguntas),
         puntos = greatest(0, puntos + p_delta_puntos)
   where id = p_jugador_id;
  return false;
end;
$$;

-- Igual que en la migración 22: la función interna no se expone a clientes.
revoke all on function public.rosco_avanzar_interno(uuid, jsonb, text, int)
  from public, anon, authenticated;
