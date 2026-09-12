-- =============================================================================
-- REALTIME FILTRADO — DELETE de jugadores con filtro server-side por sala
-- =============================================================================
-- El cliente se suscribe a `postgres_changes` con filtro por sala
-- (`id_sala=eq.<sala>`), lo que corta el fan-out entre salas: medido el
-- 2026-09-12 con 3 salas × 20 (scripts/test-carga-3-salas.mjs): 0 eventos
-- ajenos y 0 entregas perdidas (antes, ~92% de los eventos de `jugadores`
-- eran de otras salas).
--
-- Un DELETE solo lleva en el WAL las columnas de la REPLICA IDENTITY (por
-- defecto, la PK `id`), así que un filtro por `id_sala` no puede evaluarse y
-- el borrado se perdía. Con REPLICA IDENTITY FULL viaja la fila vieja completa
-- y el filtro funciona también para DELETE (expulsión / salida de jugador).
-- Costo: el WAL de cada UPDATE de `jugadores` incluye la fila anterior; con
-- salas de hasta 200 filas es despreciable.
-- =============================================================================

alter table public.jugadores replica identity full;
