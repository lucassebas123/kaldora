-- =============================================================================
-- HOTFIX — BASTA: el diccionario es ASESOR, el anfitrión decide el puntaje.
-- =============================================================================
-- Problema: palabras correctas que NO están en el diccionario (p.ej. "Hockey"
-- para Deporte con H) quedaban con existe=false y sumaban 0, aunque fueran
-- válidas y correspondieran a la categoría. El diccionario (600k+ formas de
-- an-array-of-spanish-words) no cubre extranjerismos, marcas, nombres propios,
-- videojuegos, etc., así que el rechazo automático marcaba bien como mal.
--
-- Nuevo criterio (el de la v2: "tachada 0 — el host valida"):
--   * existe / corresponde se siguen calculando en cada cierre, pero son
--     AVISOS visuales (naranja/ámbar en el panel) para que el anfitrión
--     revise. NO condicionan el puntaje.
--   * Puntaje: valida=true -> única 10 / repetida 5; valida=false -> 0.
--   * La unicidad se cuenta entre palabras VÁLIDAS no vacías.
--   * Se conserva el aprendizaje: si el anfitrión re-valida a mano una
--     palabra inexistente, basta_toggle_valida la inserta en el diccionario
--     y los cierres siguientes dejan de marcarla.
-- =============================================================================

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

  -- 1. AVISO: ¿la palabra existe en el diccionario? (no puntúa, solo marca).
  update public.respuestas_basta r
     set existe = coalesce((select true from public.palabras pw
                             where pw.palabra = public.normalizar_palabra(r.texto)), false)
   where r.id_sala = p_sala and btrim(r.texto) <> '';

  -- 2. AVISO: ¿corresponde a la categoría? (categorías sin léxico: abiertas).
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

  -- 3. Unicidad entre palabras VÁLIDAS no vacías (el anfitrión manda).
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

  -- 4. Contribución según el CRITERIO DEL ANFITRIÓN:
  --    valida y única = 10 · valida repetida = 5 · tachada o vacía = 0.
  update public.respuestas_basta
     set puntos = case
       when valida and btrim(texto) <> '' and unico then 10
       when valida and btrim(texto) <> '' then 5
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
