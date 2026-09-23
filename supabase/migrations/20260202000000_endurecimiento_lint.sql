-- =============================================================================
-- ENDURECIMIENTO — hallazgos del Database Linter de Supabase
-- =============================================================================
-- 1. DRIFT: la policy "acceso total preguntas" existía SOLO en la base real
--    (creada a mano desde el dashboard: no está en ninguna migración). Es
--    `for all using (true) with check (true)`: hoy inofensiva porque anon y
--    authenticated NO tienen privilegios de escritura en `preguntas` (solo
--    SELECT por columna), pero si algún día se otorga escritura abriría
--    INSERT/UPDATE/DELETE sin restricción. Las lecturas ya las gobierna la
--    policy "preguntas: lectura pública" y la edición va por RPCs SECURITY
--    DEFINER. Dropearla también elimina el drift base real ↔ migraciones.
--
-- 2. `function_search_path_mutable` (lint 0011): se fija `search_path = ''`
--    en los 4 helpers que no referencian nada fuera de pg_catalog
--    (`letras_rosco`, `rosco_letra_siguiente`, `reanudar_relojes`,
--    `sanitizar_texto`). Ya estaban revocados a clientes; esto es defensa en
--    profundidad contra secuestro de search_path.
--
-- 3. `extension_in_public` (lint 0014): `unaccent` y `fuzzystrmatch` se
--    mueven al schema `extensions` (donde ya vive pgcrypto). Las funciones
--    que las usan — `normalizar_palabra` y los RPCs del rosco — ya declaran
--    `set search_path = public, extensions`, así que resuelven igual.
--
-- 4. `anon_security_definer_function_executable` (lint 0028): PostgreSQL
--    otorga EXECUTE a PUBLIC en cada función nueva, así que `anon` heredaba
--    el permiso de los RPCs de HOST (fallan cerrado por `auth.uid()`, pero
--    no deben ser ni llamables). Se revoca de `public, anon` y se conserva
--    el grant a `authenticated`. Los RPCs de JUGADOR siguen anon-callables
--    por diseño (autentican por token): ese warning se documenta como riesgo
--    aceptado en docs/operacion.md §5.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Policy drift fuera
-- -----------------------------------------------------------------------------
drop policy if exists "acceso total preguntas" on public.preguntas;

-- -----------------------------------------------------------------------------
-- 2. search_path inmutable en helpers sin dependencias de schema
-- -----------------------------------------------------------------------------
alter function public.letras_rosco() set search_path = '';
alter function public.rosco_letra_siguiente(jsonb, text) set search_path = '';
alter function public.reanudar_relojes(jsonb) set search_path = '';
alter function public.sanitizar_texto(text) set search_path = '';

-- -----------------------------------------------------------------------------
-- 3. Extensiones al schema `extensions`
-- -----------------------------------------------------------------------------
alter extension unaccent set schema extensions;
alter extension fuzzystrmatch set schema extensions;

-- -----------------------------------------------------------------------------
-- 4. RPCs solo-host: sin EXECUTE para PUBLIC ni anon
-- -----------------------------------------------------------------------------
-- Explícitos (uno por función) para que `npm run auditar:api` pueda leerlos.
-- Los RPCs de JUGADOR (unirse_sala, entrar_con_identificador, rosco_*,
-- trivia_responder, basta_*, supervivencia_*, salir_sala, perfil_por_correo,
-- estado_verificacion, hora_servidor) NO se tocan: son anon-callables por
-- diseño y autentican por token.

-- Sala / lobby / partida
revoke execute on function public.crear_sala() from public, anon;
revoke execute on function public.mis_salas() from public, anon;
revoke execute on function public.borrar_sala(uuid) from public, anon;
revoke execute on function public.seleccionar_juego(uuid, text) from public, anon;
revoke execute on function public.pausar_partida(uuid) from public, anon;
revoke execute on function public.reanudar_partida(uuid) from public, anon;
revoke execute on function public.terminar_partida(uuid) from public, anon;
revoke execute on function public.volver_al_lobby(uuid) from public, anon;
revoke execute on function public.expulsar_jugador(uuid, uuid) from public, anon;

-- Juegos (avance de ronda / moderación del host)
revoke execute on function public.rosco_iniciar(uuid, int) from public, anon;
revoke execute on function public.trivia_siguiente(uuid, int) from public, anon;
revoke execute on function public.basta_iniciar_ronda(uuid) from public, anon;
revoke execute on function public.basta_toggle_valida(uuid, uuid, boolean) from public, anon;
revoke execute on function public.supervivencia_siguiente(uuid, int) from public, anon;

-- Bancos de preguntas
revoke execute on function public.cargar_banco(text, jsonb) from public, anon;
revoke execute on function public.guardar_pregunta_rosco(text, text, text, uuid) from public, anon;
revoke execute on function public.guardar_pregunta_trivia(text, jsonb, int, uuid) from public, anon;
revoke execute on function public.guardar_pregunta_supervivencia(text, boolean, uuid) from public, anon;
revoke execute on function public.borrar_pregunta(text, uuid) from public, anon;

-- Administradores
revoke execute on function public.cambiar_rol_admin(uuid, text) from public, anon;
revoke execute on function public.quitar_admin(uuid) from public, anon;

-- Verificación de WhatsApp (PII)
revoke execute on function public.verificaciones_pendientes(uuid) from public, anon;
revoke execute on function public.confirmar_verificacion(uuid, uuid) from public, anon;
revoke execute on function public.actualizar_contacto_whatsapp(uuid, text) from public, anon;
