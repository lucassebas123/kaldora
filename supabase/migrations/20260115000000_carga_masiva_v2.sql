-- =============================================================================
-- CARGA MASIVA v2 — Batch insert de una sola sentencia + sanitización
-- =============================================================================
-- Cambios sobre cargar_banco / guardar_pregunta_*:
--
-- 1. BATCH INSERT REAL (antes: bucle con un INSERT por ítem). Todo el lote
--    entra con UNA sola sentencia `INSERT ... SELECT FROM jsonb_array_elements`
--    por banco: menos round-trips internos, un solo plan, y la misma atomicidad
--    (una RPC = una transacción: si algo falla, NO queda el banco "a medias").
--
-- 2. Tolerancia preservada: los ítems inválidos se FILTRAN en el WHERE
--    (como hacía el bucle), no rompen el lote. Se usa `->>` (nunca falla
--    sobre valores no escalares) en vez de casts estructurales.
--
-- 3. SANITIZACIÓN XSS en el punto de frontera: todo texto que entra a los
--    bancos pasa por `sanitizar_texto` (elimina etiquetas HTML tipo
--    <script>...</script> y caracteres de control). React ya escapa al
--    renderizar; esto evita guardar basura que otros consumidores (feeds,
--    exports, emails) podrían inyectar sin escapar.
--
-- 4. Tope de lote: 5000 ítems por llamada (anti-DoS / timeouts).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Sanitizador de texto (etiquetas HTML + caracteres de control)
-- -----------------------------------------------------------------------------
create or replace function public.sanitizar_texto(p text)
returns text
language sql
immutable
as $$
  select btrim(
    regexp_replace(
      regexp_replace(
        coalesce(p, ''),
        '</?[a-zA-Z][^>]*>',  -- etiquetas HTML (<script>, <img ...>, etc.)
        '',
        'g'
      ),
      E'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]',  -- caracteres de control
      '',
      'g'
    )
  );
$$;

revoke all on function public.sanitizar_texto(text) from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- cargar_banco: un solo INSERT ... SELECT por banco
-- -----------------------------------------------------------------------------
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
  v_count int := 0;
begin
  if auth.uid() is null then
    raise exception 'Debés iniciar sesión como anfitrión' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Se espera un array de ítems' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 5000 then
    raise exception 'Máximo 5000 ítems por lote: dividilo en varios' using errcode = 'P0001';
  end if;

  case p_banco
    when 'rosco' then
      insert into public.preguntas (letra, pregunta, respuesta)
      select x.item ->> 'letra',
             public.sanitizar_texto(x.item ->> 'pregunta'),
             public.sanitizar_texto(x.item ->> 'respuesta')
        from jsonb_array_elements(p_items) as x(item)
       where jsonb_typeof(x.item) = 'object'
         and coalesce(x.item ->> 'letra', '') ~ '^[A-ZÑ]$'
         and coalesce(x.item ->> 'pregunta', '') <> ''
         and coalesce(x.item ->> 'respuesta', '') <> '';
      get diagnostics v_count = row_count;

    when 'trivia' then
      insert into public.preguntas_trivia (pregunta, opciones, indice_correcto)
      select public.sanitizar_texto(x.item ->> 'pregunta'),
             (select array_agg(public.sanitizar_texto(t))
                from jsonb_array_elements_text(x.item -> 'opciones') t),
             (x.item ->> 'indice_correcto')::int
        from jsonb_array_elements(p_items) as x(item)
       where jsonb_typeof(x.item) = 'object'
         and coalesce(x.item ->> 'pregunta', '') <> ''
         and jsonb_typeof(x.item -> 'opciones') = 'array'
         and jsonb_array_length(x.item -> 'opciones') between 2 and 4
         and coalesce(x.item ->> 'indice_correcto', '') ~ '^[0-9]+$'
         and (x.item ->> 'indice_correcto')::int
             between 0 and jsonb_array_length(x.item -> 'opciones') - 1;
      get diagnostics v_count = row_count;

    when 'supervivencia' then
      insert into public.preguntas_supervivencia (pregunta, es_verdadera)
      select public.sanitizar_texto(x.item ->> 'pregunta'),
             (x.item ->> 'es_verdadera')::boolean
        from jsonb_array_elements(p_items) as x(item)
       where jsonb_typeof(x.item) = 'object'
         and coalesce(x.item ->> 'pregunta', '') <> ''
         and coalesce(x.item ->> 'es_verdadera', '') in ('true', 'false');
      get diagnostics v_count = row_count;

    else
      raise exception 'Banco desconocido' using errcode = 'P0001';
  end case;

  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- Guardado unitario: misma sanitización (edición manual de filas)
-- -----------------------------------------------------------------------------
create or replace function public.guardar_pregunta_rosco(
  p_letra text,
  p_pregunta text,
  p_respuesta text,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_letra text := upper(btrim(p_letra));
  v_pregunta text := public.sanitizar_texto(p_pregunta);
  v_respuesta text := public.sanitizar_texto(p_respuesta);
  v_id uuid;
begin
  perform public.exigir_admin();

  if v_letra !~ '^[A-ZÑ]$' then
    raise exception 'Letra inválida' using errcode = 'P0001';
  end if;
  if v_pregunta = '' or v_respuesta = '' then
    raise exception 'Pregunta y respuesta son obligatorias' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas (letra, pregunta, respuesta)
    values (v_letra, v_pregunta, v_respuesta)
    returning id into v_id;
  else
    update public.preguntas
       set letra = v_letra, pregunta = v_pregunta, respuesta = v_respuesta
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La pregunta ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.guardar_pregunta_trivia(
  p_pregunta text,
  p_opciones jsonb,
  p_indice int,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pregunta text := public.sanitizar_texto(p_pregunta);
  v_opciones text[];
  v_id uuid;
begin
  perform public.exigir_admin();

  if jsonb_typeof(p_opciones) <> 'array' or jsonb_array_length(p_opciones) not between 2 and 4 then
    raise exception 'Deben ser entre 2 y 4 opciones' using errcode = 'P0001';
  end if;
  select array_agg(public.sanitizar_texto(x)) from jsonb_array_elements_text(p_opciones) x into v_opciones;
  if v_pregunta = '' then
    raise exception 'La pregunta es obligatoria' using errcode = 'P0001';
  end if;
  if p_indice not between 0 and cardinality(v_opciones) - 1 then
    raise exception 'El índice de la opción correcta no corresponde' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas_trivia (pregunta, opciones, indice_correcto)
    values (v_pregunta, v_opciones, p_indice)
    returning id into v_id;
  else
    update public.preguntas_trivia
       set pregunta = v_pregunta, opciones = v_opciones, indice_correcto = p_indice
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La pregunta ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;

create or replace function public.guardar_pregunta_supervivencia(
  p_pregunta text,
  p_es_verdadera boolean,
  p_pregunta_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pregunta text := public.sanitizar_texto(p_pregunta);
  v_id uuid;
begin
  perform public.exigir_admin();
  if v_pregunta = '' then
    raise exception 'La frase es obligatoria' using errcode = 'P0001';
  end if;

  if p_pregunta_id is null then
    insert into public.preguntas_supervivencia (pregunta, es_verdadera)
    values (v_pregunta, p_es_verdadera)
    returning id into v_id;
  else
    update public.preguntas_supervivencia
       set pregunta = v_pregunta, es_verdadera = p_es_verdadera
     where id = p_pregunta_id
    returning id into v_id;
    if not found then
      raise exception 'La frase ya no existe' using errcode = 'P0001';
    end if;
  end if;

  return v_id;
end;
$$;
