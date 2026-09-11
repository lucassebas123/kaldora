-- =============================================================================
-- HOTFIX — basta_declarar_completo: alias faltante en la subconsulta de
-- categorías completas ("column c does not exist").
-- =============================================================================
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
