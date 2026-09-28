-- =============================================================================
-- KALDORA — AJUSTES MANUALES PARA EVENTO CON ROTACIÓN DE SALAS
-- =============================================================================
-- USO: pegar cada bloque en el SQL Editor de Supabase y ejecutar a mano.
--
-- ⚠️ ESTE ARCHIVO NO ES UNA MIGRACIÓN: no vive en supabase/migrations/ y no
--    debe ejecutarse con `supabase db push`. Son ajustes operativos puntuales
--    para un evento con IP compartida (NAT del Wi-Fi) y mucha rotación de
--    jugadores. La tabla `limites_acceso` existe exactamente para esto
--    (migración 20260127000000_limites_ajustables.sql): cambiar un umbral es
--    un UPDATE, sin recrear funciones.
--
-- Contexto: los umbrales cuentan SOLO fallos (PIN inexistente, login
-- desconocido) por IP pública. En un evento, 15 jugadores por sala × varios
-- ciclos comparten la misma IP: conviene dar más margen.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 1) SUBIR UMBRALES (ejecutar antes del evento)
-- -----------------------------------------------------------------------------
update public.limites_acceso set maximo = 300 where accion = 'pin_fallos';    -- default 60
update public.limites_acceso set maximo = 200 where accion = 'login_fallos';  -- default 40
update public.limites_acceso set maximo = 600 where accion = 'perfil_fallos'; -- default 150


-- -----------------------------------------------------------------------------
-- 2) VERIFICAR UMBRALES VIGENTES
-- -----------------------------------------------------------------------------
select accion, maximo, ventana
  from public.limites_acceso
 order by accion;


-- -----------------------------------------------------------------------------
-- 3) VERIFICAR BANCOS CARGADOS (antes del evento)
-- -----------------------------------------------------------------------------
select 'rosco'          as banco, count(*) as filas from public.preguntas
union all
select 'trivia',                   count(*)          from public.preguntas_trivia
union all
select 'supervivencia',            count(*)          from public.preguntas_supervivencia
union all
select 'categorias_basta',         count(*)          from public.categorias_basta;

-- Distribución por letra del rosco (ideal: 3–5 por letra):
select letra, count(*)
  from public.preguntas
 group by letra
 order by letra;


-- -----------------------------------------------------------------------------
-- 4) REVERTIR UMBRALES (ejecutar después del evento, opcional)
-- -----------------------------------------------------------------------------
update public.limites_acceso set maximo = 60  where accion = 'pin_fallos';
update public.limites_acceso set maximo = 40  where accion = 'login_fallos';
update public.limites_acceso set maximo = 150 where accion = 'perfil_fallos';
