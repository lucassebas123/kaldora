-- =============================================================================
-- LIMPIEZA — residuo público de la v2: rosco_enviar_respuesta
-- =============================================================================
-- Hallazgo de scripts/auditar-api.mjs (modo LIVE): la migración v3 quiso
-- eliminar `rosco_enviar_respuesta` pero usó la firma equivocada:
--   drop function if exists public.rosco_enviar_respuesta(text, text);  -- 2 args
-- y la función real de la v2 tenía 3 args (p_token, p_letra, p_respuesta).
-- Resultado: quedó viva, con EXECUTE para anon y authenticated, apuntando al
-- modelo viejo del rosco (salas.juego.letra). En la v3 falla al no encontrar
-- pregunta, pero es superficie pública muerta: se elimina.
-- =============================================================================

drop function if exists public.rosco_enviar_respuesta(text, text, text);
drop function if exists public.rosco_enviar_respuesta(text, text);
