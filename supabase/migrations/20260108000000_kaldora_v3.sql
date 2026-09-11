-- =============================================================================
-- KALDORA v3 — Rosco individual + validación con diccionario + perfil por correo
-- =============================================================================
-- 1) EL ROSCO pasa a modo INDIVIDUAL (estilo Pasapalabra clásico):
--    * Reloj TOTAL continuo por partida (juego.inicio + juego.duracion_ms):
--      corre de forma ininterrumpida hasta llegar a cero o hasta que el
--      jugador resuelva todo el rosco.
--    * PASAPALABRA: la letra queda "pendiente" (sin puntos ni error) y se
--      avanza; al terminar la pasada, el ciclo vuelve en círculo SOLO por las
--      letras pendientes, respetando el orden original del abecedario, hasta
--      que se acabe el tiempo o no queden pendientes.
--    * Estado individual en `jugadores.rosco` (compacto):
--        { l: letra actual, q: pregunta fija de esa letra,
--          e: { A:1 acierto, 2:error, 3:pasapalabra, 4:sin_pregunta },
--          t: terminado }
--    * +100 acierto / −50 error / pasapalabra 0.
--
-- 2) BASTA con DICIONARIO: al cerrar la ronda se valida cada palabra contra
--    `palabras` (español + argentino) y contra el léxico por categoría
--    (`lexico_categorias` via categorias_basta.clave_lexico). Columnas nuevas
--    `existe` y `corresponde` en respuestas_basta. Si el host valida a mano
--    una palabra inexistente, el diccionario la aprende.
--
-- 3) PERFIL POR CORREO: quien ya jugó alguna vez solo se identifica con su
--    correo y recupera nombre/apellido/teléfono (no vuelve a registrarse).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. ROSCO INDIVIDUAL
-- -----------------------------------------------------------------------------
alter table public.jugadores add column if not exists rosco jsonb not null default '{}';

-- Permisos por columna (se re-emiten con la nueva columna incluida).
revoke all privileges on public.jugadores from anon, authenticated;
grant select (id, id_sala, nickname, icono, color, puntos, racha, eliminado, rosco, creado_en)
  on public.jugadores to anon, authenticated;

-- Helper: próxima letra pendiente en orden circular del abecedario.
-- Pendiente = nunca tocada (ausente) o 'pasapalabra' (3). Primera pasada:
-- solo nunca tocadas; si no quedan, ciclo por las pasapalabra.
create or replace function public.rosco_letra_siguiente(p_estados jsonb, p_desde text)
returns text
language plpgsql
immutable
as $$
declare
  v_letras text[] := array['A','B','C','D','E','F','G','H','I','J','K','L','M','N','Ñ',
                           'O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  v_n int := cardinality(v_letras);
  v_idx int := coalesce(array_position(v_letras, p_desde), 0);
  v_paso int;
  v_pos int;
  v_letra text;
  v_estado int;
begin
  for v_paso in 1..v_n loop
    v_pos := ((v_idx - 1 + v_paso) % v_n) + 1;
    v_letra := v_letras[v_pos];
    v_estado := coalesce((p_estados ->> v_letra)::int, 0); -- 0 = nunca tocada
    if v_estado = 0 then
      return v_letra;
    end if;
  end loop;

  -- Segunda vuelta: solo pasapalabras (pendientes).
  for v_paso in 1..v_n loop
    v_pos := ((v_idx - 1 + v_paso) % v_n) + 1;
    v_letra := v_letras[v_pos];
    if coalesce((p_estados ->> v_letra)::int, 0) = 3 then
      return v_letra;
    end if;
  end loop;

  return null; -- no quedan pendientes
end;
$$;

create or replace function public.elegir_pregunta_letra(p_letra text)
returns uuid
language sql
security definer
set search_path = public
as $$
  select id from public.preguntas
   where letra = upper(btrim(p_letra))
   order by random()
   limit 1;
$$;

-- Inicia el rosco: reloj total continuo + estado inicial por jugador.
create or replace function public.rosco_iniciar(p_sala uuid, p_duracion_seg int default 150)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sala public.salas;
  v_pregunta_id uuid;
  v_duracion int := greatest(60, least(1200, coalesce(p_duracion_seg, 150)));
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

-- Responde la letra actual. +100 acierto / -50 error. Valida contra la
-- pregunta FIJA de la letra y dentro de la ventana de tiempo total.
create or replace function public.rosco_enviar(p_token text, p_respuesta text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_ctx record;
  v_pregunta record;
  v_limpiar text;
  v_valida text;
  v_correcta boolean;
  v_puntos int;
  v_estados jsonb;
begin
  select * into v_ctx from public.rosco_ctx(p_token);

  if not v_ctx.tiempo_ok then
    raise exception 'El tiempo del rosco terminó' using errcode = 'P0001';
  end if;
  if v_ctx.terminado then
    raise exception 'Ya terminaste tu rosco' using errcode = 'P0001';
  end if;
  if v_ctx.letra is null or v_ctx.pregunta_id is null then
    raise exception 'No hay letra activa' using errcode = 'P0001';
  end if;

  select respuesta into v_pregunta
    from public.preguntas
   where id = v_ctx.pregunta_id::uuid;
  if not found then
    raise exception 'No hay pregunta cargada para esta letra' using errcode = 'P0001';
  end if;

  v_limpiar := public.normalizar_palabra(p_respuesta);
  v_valida := public.normalizar_palabra(v_pregunta.respuesta);

  if v_limpiar = '' then
    v_correcta := false;
  else
    v_correcta := v_limpiar = v_valida
      or levenshtein(v_limpiar, v_valida) <= greatest(1, floor(char_length(v_valida) / 4.0)::int);
  end if;

  v_puntos := case when v_correcta then 100 else -50 end;
  v_estados := jsonb_set(coalesce(v_ctx.estados, '{}'::jsonb),
                         array[v_ctx.letra],
                         to_jsonb(case when v_correcta then 1 else 2 end), true);

  -- Auditoría (una respuesta por letra: la pasapalabra no inserta).
  insert into public.rosco_respuestas (id_sala, id_jugador, letra, correcta, puntos)
  values (v_ctx.sala_id, v_ctx.jugador_id, v_ctx.letra, v_correcta, v_puntos);

  perform public.sumar_puntos(v_ctx.jugador_id, v_puntos);

  perform public.rosco_avanzar_interno(v_ctx.jugador_id, v_estados, v_ctx.letra);

  return jsonb_build_object(
    'correcta', v_correcta,
    'puntos', v_puntos,
    'letra', (select rosco ->> 'l' from public.jugadores where id = v_ctx.jugador_id),
    'terminado', coalesce((select (rosco ->> 't')::boolean from public.jugadores where id = v_ctx.jugador_id), false)
  );
end;
$$;

-- PASAPALABRA: la letra queda pendiente (estado 3, sin puntos) y avanza.
create or replace function public.rosco_pasar(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_estados jsonb;
begin
  select * into v_ctx from public.rosco_ctx(p_token);

  if not v_ctx.tiempo_ok then
    raise exception 'El tiempo del rosco terminó' using errcode = 'P0001';
  end if;
  if v_ctx.terminado then
    raise exception 'Ya terminaste tu rosco' using errcode = 'P0001';
  end if;
  if v_ctx.letra is null then
    raise exception 'No hay letra activa' using errcode = 'P0001';
  end if;

  -- 3 = pasapalabra: pendiente, sin puntos ni error.
  v_estados := jsonb_set(coalesce(v_ctx.estados, '{}'::jsonb),
                         array[v_ctx.letra], '3', true);

  perform public.rosco_avanzar_interno(v_ctx.jugador_id, v_estados, v_ctx.letra);

  return jsonb_build_object(
    'letra', (select rosco ->> 'l' from public.jugadores where id = v_ctx.jugador_id),
    'terminado', coalesce((select (rosco ->> 't')::boolean from public.jugadores where id = v_ctx.jugador_id), false)
  );
end;
$$;

-- Cierra el rosco del jugador si su tiempo terminó (o todo resuelto).
create or replace function public.rosco_cerrar(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ctx record;
  v_jugador_row public.jugadores;
begin
  select * into v_ctx from public.rosco_ctx(p_token);

  if not v_ctx.tiempo_ok and not v_ctx.terminado then
    return jsonb_build_object('cerrado', false);
  end if;

  select * into v_jugador_row from public.jugadores where id = v_ctx.jugador_id for update;
  update public.jugadores
     set rosco = coalesce(v_jugador_row.rosco, '{}'::jsonb) || jsonb_build_object('t', true)
   where id = v_ctx.jugador_id;

  return jsonb_build_object('cerrado', true);
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
    'duracion_ms', coalesce((v_sala.juego ->> 'duracion_ms')::int, 150000)
  );
end;
$$;

-- Los RPC del rosco sincronizado v2 quedan reemplazados.
drop function if exists public.rosco_iniciar(uuid);
drop function if exists public.rosco_avanzar(uuid, text);
drop function if exists public.rosco_enviar_respuesta(text, text);
drop function if exists public.rosco_corregir(uuid, uuid, boolean);

-- volver_al_lobby también limpia el estado individual del rosco.
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
  delete from public.trivia_respuestas where id_sala = p_sala;

  update public.jugadores
     set puntos = 0, racha = 0, eliminado = false, rosco = '{}'::jsonb
   where id_sala = p_sala;

  update public.salas
     set estado = 'en_espera', juego_actual = null, juego = '{}'::jsonb
   where id = p_sala;
end;
$$;

-- -----------------------------------------------------------------------------
-- 2. BASTA + DICCIONARIO
-- -----------------------------------------------------------------------------
alter table public.respuestas_basta
  add column if not exists existe boolean,
  add column if not exists corresponde boolean;

revoke all privileges on public.respuestas_basta from anon, authenticated;
grant select (id, id_sala, id_jugador, id_categoria, texto, valida, unico, puntos, existe, corresponde, creado_en)
  on public.respuestas_basta to anon, authenticated;

alter table public.categorias_basta add column if not exists clave_lexico text;

update public.categorias_basta set clave_lexico = sub.clave
from (values
  ('Nombre de persona', 'persona'),
  ('Animal', 'animal'),
  ('País o ciudad', 'pais'),
  ('Color', 'color'),
  ('Comida o plato', 'comida'),
  ('Fruta o verdura', 'fruta'),
  ('Deporte', 'deporte'),
  ('Profesión u oficio', 'profesion')
) as sub(nombre, clave)
where categorias_basta.nombre = sub.nombre;

-- Cierre de ronda con validación por diccionario + léxico de categoría.
create or replace function public.basta_cerrar_ronda(p_sala uuid)
returns void
language plpgsql
security definer
set search_path = public, extensions
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

  if v_es_host then
    if coalesce(v_sala.juego ->> 'fase', '') not in ('escribiendo', 'cuenta_atras', 'resultados') then
      return;
    end if;
  else
    if (v_sala.juego ->> 'fase') <> 'cuenta_atras' then return; end if;
    if clock_timestamp() < (v_sala.juego ->> 'deadline')::timestamptz then return; end if;
  end if;

  -- 1. ¿La palabra existe en el diccionario (español + argentino)?
  update public.respuestas_basta r
     set existe = coalesce((select true from public.palabras pw
                             where pw.palabra = public.normalizar_palabra(r.texto)), false)
   where r.id_sala = p_sala and btrim(r.texto) <> '';

  -- 2. ¿Corresponde a la categoría? (categorías sin léxico: abiertas)
  update public.respuestas_basta r
     set corresponde = case
       when coalesce(c.clave_lexico, '') = '' then true
       else coalesce((select true
                        from public.lexico_categorias lx
                       where lx.id_categoria = r.id_categoria
                         and lx.palabra = public.normalizar_palabra(r.texto)), false)
     end
   from public.categorias_basta c
   where r.id_categoria = c.id and r.id_sala = p_sala;

  -- 3. Unicidad entre palabras ACEPTADAS (validas + existen + corresponden).
  update public.respuestas_basta r
     set unico = sub.n_iguales = 1
    from (
      select b.id,
             (select count(*)
                from public.respuestas_basta x
               where x.id_sala = b.id_sala
                 and x.id_categoria = b.id_categoria
                 and x.valida and coalesce(x.existe, false) and coalesce(x.corresponde, false)
                 and btrim(x.texto) <> ''
                 and public.normalizar_palabra(x.texto)
                     = public.normalizar_palabra(b.texto)
             )::int as n_iguales
        from public.respuestas_basta b
       where b.id_sala = p_sala
    ) sub
   where r.id = sub.id;

  -- 4. Contribución: aceptada y única = 10; aceptada repetida = 5; si no, 0.
  update public.respuestas_basta
     set puntos = case
       when valida and coalesce(existe, false) and coalesce(corresponde, false)
            and btrim(texto) <> '' and unico then 10
       when valida and coalesce(existe, false) and coalesce(corresponde, false)
            and btrim(texto) <> '' then 5
       else 0
     end
   where id_sala = p_sala;

  -- 5. Recalcula el total desde el snapshot de la ronda (idempotente).
  for v_jugador in select id from public.jugadores where id_sala = p_sala
  loop
    v_puntos_base := coalesce((v_sala.juego -> 'puntos_base' ->> v_jugador.id::text)::int, 0);
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

-- El host tacha/valida. Si VALIDA una palabra inexistente, el diccionario
-- la aprende (crece con el uso).
create or replace function public.basta_toggle_valida(
  p_sala uuid,
  p_id_respuesta uuid,
  p_valida boolean
)
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_texto text;
begin
  perform public.sala_del_anfitrion(p_sala);

  select texto into v_texto
    from public.respuestas_basta
   where id = p_id_respuesta and id_sala = p_sala;

  update public.respuestas_basta
     set valida = p_valida
   where id = p_id_respuesta and id_sala = p_sala;

  if p_valida and v_texto is not null and btrim(v_texto) <> '' then
    insert into public.palabras (palabra)
    values (public.normalizar_palabra(v_texto))
    on conflict (palabra) do nothing;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. PERFIL POR CORREO (quien ya jugó solo se identifica)
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
  v_jugador public.jugadores;
begin
  if v_correo !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    return jsonb_build_object('existe', false);
  end if;

  select r.nombre, r.apellido, r.telefono, j.nickname
    into v_registro
    from public.registros_jugadores r
    join public.jugadores j on j.id = r.id_jugador
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

-- -----------------------------------------------------------------------------
-- Permisos
-- -----------------------------------------------------------------------------
revoke all on function public.rosco_letra_siguiente(jsonb, text) from public, anon, authenticated;
revoke all on function public.elegir_pregunta_letra(text) from public, anon, authenticated;
revoke all on function public.rosco_ctx(text) from public, anon, authenticated;
revoke all on function public.rosco_avanzar_interno(uuid, jsonb, text) from public, anon, authenticated;
revoke all on function public.es_dueno() from public, anon, authenticated;

grant execute on function public.rosco_iniciar(uuid, int) to authenticated;
grant execute on function public.rosco_enviar(text, text) to anon, authenticated;
grant execute on function public.rosco_pasar(text) to anon, authenticated;
grant execute on function public.rosco_cerrar(text) to anon, authenticated;
grant execute on function public.rosco_estado(text) to anon, authenticated;
grant execute on function public.perfil_por_correo(text) to anon, authenticated;
