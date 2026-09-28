-- =============================================================================
-- BANCOS SEMILLA — carga del contenido del evento en un toque
-- =============================================================================
-- Los bancos de docs/bancos/*.json se publican una vez en `bancos_semilla`
-- (tabla privada: contiene las respuestas correctas, así que NO se publica en
-- Realtime ni tiene grants de cliente) y el botón "Cargar bancos del evento"
-- del Banco de Preguntas llama a `importar_banco_semilla`, que copia a las
-- tablas reales solo lo que falta (dedupe por `normalizar_palabra(pregunta)`):
-- correrlo dos veces no duplica.
--
-- `publicar_banco_semilla` la usa `scripts/importar-bancos.mjs` (y el workflow
-- `importar-bancos`) con la sesión de un anfitrión autorizado.
-- =============================================================================

create table if not exists public.bancos_semilla (
  id bigint generated always as identity primary key,
  banco text not null check (banco in ('rosco', 'trivia', 'supervivencia')),
  item jsonb not null,
  publicado_en timestamptz not null default now()
);

alter table public.bancos_semilla enable row level security;
revoke all privileges on public.bancos_semilla from anon, authenticated;

create index if not exists idx_bancos_semilla_banco on public.bancos_semilla (banco);

-- -----------------------------------------------------------------------------
-- publicar_banco_semilla: reemplaza el contenido semilla de un banco. Solo
-- anfitriones autorizados. Devuelve cuántos ítems quedaron publicados.
-- -----------------------------------------------------------------------------
create or replace function public.publicar_banco_semilla(p_banco text, p_items jsonb)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  perform public.exigir_admin();

  if p_banco not in ('rosco', 'trivia', 'supervivencia') then
    raise exception 'Banco desconocido' using errcode = 'P0001';
  end if;
  if jsonb_typeof(p_items) <> 'array' then
    raise exception 'Se espera un array de ítems' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_items) > 5000 then
    raise exception 'Máximo 5000 ítems por banco: dividilo en varios' using errcode = 'P0001';
  end if;

  delete from public.bancos_semilla where banco = p_banco;
  insert into public.bancos_semilla (banco, item)
  select p_banco, x.item
    from jsonb_array_elements(p_items) as x(item)
   where jsonb_typeof(x.item) = 'object';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- importar_banco_semilla: copia a las tablas reales solo lo que no existe
-- (dedupe por pregunta normalizada, también dentro del propio lote). Devuelve
-- { insertados, omitidos, total }. Solo anfitriones autorizados.
-- -----------------------------------------------------------------------------
create or replace function public.importar_banco_semilla(p_banco text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_insertados int := 0;
  v_semilla int := 0;
  v_total int := 0;
begin
  perform public.exigir_admin();

  if p_banco not in ('rosco', 'trivia', 'supervivencia') then
    raise exception 'Banco desconocido' using errcode = 'P0001';
  end if;

  select count(*) into v_semilla
    from public.bancos_semilla
   where banco = p_banco;
  if v_semilla = 0 then
    raise exception 'El banco % no está publicado: corré npm run importar:bancos o el workflow importar-bancos', p_banco
      using errcode = 'P0001';
  end if;

  if p_banco = 'rosco' then
    insert into public.preguntas (letra, pregunta, respuesta)
    select distinct on (public.normalizar_palabra(s.item ->> 'pregunta'))
           upper(btrim(s.item ->> 'letra')),
           public.sanitizar_texto(s.item ->> 'pregunta'),
           public.sanitizar_texto(s.item ->> 'respuesta')
      from public.bancos_semilla s
     where s.banco = 'rosco'
       and coalesce(s.item ->> 'letra', '') ~ '^[A-ZÑ]$'
       and coalesce(s.item ->> 'pregunta', '') <> ''
       and coalesce(s.item ->> 'respuesta', '') <> ''
       and not exists (
         select 1 from public.preguntas p
          where public.normalizar_palabra(p.pregunta) = public.normalizar_palabra(s.item ->> 'pregunta')
       );
    get diagnostics v_insertados = row_count;
    select count(*) into v_total from public.preguntas;

  elsif p_banco = 'trivia' then
    insert into public.preguntas_trivia (pregunta, opciones, indice_correcto)
    select distinct on (public.normalizar_palabra(s.item ->> 'pregunta'))
           public.sanitizar_texto(s.item ->> 'pregunta'),
           (select array_agg(public.sanitizar_texto(t))
              from jsonb_array_elements_text(s.item -> 'opciones') t),
           (s.item ->> 'indice_correcto')::int
      from public.bancos_semilla s
     where s.banco = 'trivia'
       and coalesce(s.item ->> 'pregunta', '') <> ''
       and jsonb_typeof(s.item -> 'opciones') = 'array'
       and jsonb_array_length(s.item -> 'opciones') between 2 and 4
       and coalesce(s.item ->> 'indice_correcto', '') ~ '^[0-9]+$'
       and (s.item ->> 'indice_correcto')::int between 0 and jsonb_array_length(s.item -> 'opciones') - 1
       and not exists (
         select 1 from public.preguntas_trivia p
          where public.normalizar_palabra(p.pregunta) = public.normalizar_palabra(s.item ->> 'pregunta')
       );
    get diagnostics v_insertados = row_count;
    select count(*) into v_total from public.preguntas_trivia;

  else
    insert into public.preguntas_supervivencia (pregunta, es_verdadera)
    select distinct on (public.normalizar_palabra(s.item ->> 'pregunta'))
           public.sanitizar_texto(s.item ->> 'pregunta'),
           (s.item ->> 'es_verdadera')::boolean
      from public.bancos_semilla s
     where s.banco = 'supervivencia'
       and coalesce(s.item ->> 'pregunta', '') <> ''
       and coalesce(s.item ->> 'es_verdadera', '') in ('true', 'false')
       and not exists (
         select 1 from public.preguntas_supervivencia p
          where public.normalizar_palabra(p.pregunta) = public.normalizar_palabra(s.item ->> 'pregunta')
       );
    get diagnostics v_insertados = row_count;
    select count(*) into v_total from public.preguntas_supervivencia;
  end if;

  return jsonb_build_object(
    'insertados', v_insertados,
    'omitidos', greatest(0, v_semilla - v_insertados),
    'total', v_total
  );
end;
$$;

-- Solo anfitriones autenticados (el helper `exigir_admin` revalida adentro).
revoke all on function public.publicar_banco_semilla(text, jsonb) from public, anon, authenticated;
revoke all on function public.importar_banco_semilla(text) from public, anon, authenticated;
grant execute on function public.publicar_banco_semilla(text, jsonb) to authenticated;
grant execute on function public.importar_banco_semilla(text) to authenticated;
