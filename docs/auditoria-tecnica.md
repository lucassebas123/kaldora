# Auditoría técnica — Sincronización de estado y concurrencia (KALDORA)

> Alcance: lógica de los 4 minijuegos bajo carga concurrente (10 jugadores
> simultáneos). Backend: Postgres (Supabase) con RPCs SECURITY DEFINER.
> Métodos: lectura línea a línea del SQL del servidor + test de estrés
> `scripts/test-concurrencia.mjs` ejecutado contra la base real.

---

## 1. Ciclo de vida del estado por juego

Todos los juegos comparten la misma columna `salas.estado`
(`en_espera → jugando → pausado → finalizado`) y el jsonb volátil
`salas.juego` (una transición = un solo evento Realtime).

| Fase | Rosco (v3, individual) | Trivia | Basta | Supervivencia |
| --- | --- | --- | --- | --- |
| **Lobby** | `en_espera`, `juego_actual=rosco` (host) | idem | idem | idem |
| **Init** | `rosco_iniciar` fija `juego={inicio, duracion_ms}` y por jugador `rosco={l,q,e,t}` (letra A + pregunta fija) | `trivia_siguiente` fija `{pregunta_id, inicio, duracion_ms, ronda}` | `basta_iniciar_ronda` fija `{fase:escribiendo, letra, categorias, inicio, puntos_base}` | `supervivencia_siguiente` fija `{pregunta_id, inicio, duracion_ms, ronda}` |
| **In progress** | cada jugador actúa sobre SU fila (`rosco_enviar/pasar/cerrar`); reloj total por deadline | respuestas con puntaje decreciente contra `inicio` | hasta 5 upserts por jugador; `basta_declarar_completo` fija `fase=cuenta_atras + deadline` | V/F; un error elimina |
| **Resolution** | estado por letra (1 acierto / 2 error / 3 pasapalabra) + auditoría | `update trivia_respuestas` + racha | `basta_cerrar_ronda`: unicidad + puntaje según el host | `supervivencia_procesar`: elimina callados |
| **Game over** | rosco terminado (`t=true`) o tiempo agotado | host avanza o termina | `fase=resultados` | vivos ≤ 1 → `terminar_partida` |

**Emisión de eventos**: `postgres_changes` (solo `salas` + `jugadores`, filtrado
en cliente por entrega intermitente), **broadcast** del canal compartido
`sala:{id}` (contadores, avisos, instantánea, reloj) y **polling de respaldo
cada 3 s** + vigilante de reconexión. El estado del servidor es la única
fuente de verdad: cada acción es una RPC que re-valida estado/tiempo con
`clock_timestamp()` del servidor; los clientes solo *pintan*.

## 2. Sincronización de tiempo (lección del bug 00.0)

* **El servidor fija `juego.inicio` (`clock_timestamp()`) y `duracion_ms`**;
  todo el puntaje/eliminación se mide server-side. Un cliente modificado no
  puede puntuar mejor (verificado por el E2E de seguridad).
* Los clientes **derivan el deadline** `inicio + duracion_ms` (helper
  `calcularFin`) para el RENDER. Nunca calculan puntajes.
* `offsetReloj` (ping/pong broadcast contra el host) solo corrige el render.
* Gracias de tolerancia server-side: trivia +2 s, supervivencia +1.5 s,
  rosco +2.5 s — absorben la deriva entre el reloj de la BD y los locales.
* **Riesgo residual documentado**: la deriva entre el reloj de la base y el
  del navegador del host afecta solo al render, no al puntaje.

## 3. Hallazgos de concurrencia (race conditions)

| # | Severidad | Hallazgo | Estado |
| --- | --- | --- | --- |
| V1 | **ALTA** | Supervivencia: `responder` no serializaba contra `procesar`. Ventana [400ms, 1500ms] tras el deadline: una respuesta en vuelo podía confirmarse después del snapshot del procesar → **eliminado con respuesta correcta registrada**. | **Corregido** (migración 14): `responder` toma el mismo `for update` de la fila de sala y re-chequea eliminado/tiempo bajo lock. |
| V2 | **ALTA** | Rosco: **lost update** del jsonb `jugadores.rosco` (lectura sin lock + overwrite). Doble acción del mismo dispositivo (enviar+pasar) podía dejar una letra "pendiente" CON auditoría insertada → `unique_violation` al reintentar → **rosco trabado** para ese jugador. | **Corregido**: `for update` de la fila del jugador ANTES de leer el estado (enviar/pasar/cerrar). Jugadores distintos tocan filas distintas: cero contención. |
| V3 | **MEDIA** | Acciones del host sin serializar: doble disparo de `trivia_siguiente`/`supervivencia_siguiente`/`basta_iniciar_ronda` generaba dos preguntas/letras (la segunda pisaba la primera, con respuestas ya emitidas contra la vieja). Doble `reanudar` desplazaba los relojes **dos veces**. | **Corregido**: `for update` de la fila de sala al inicio de cada RPC que muta `salas`. |
| V4 | **BAJA** | Error crudo ("duplicate key") al doble-responder la misma letra del rosco. | **Corregido**: captura `unique_violation` → 'Ya respondiste esta letra'. |
| V5 | **MEDIA** | Trivia: una respuesta en vuelo justo cuando el host rotaba la pregunta podía registrarse (y puntuar) contra la pregunta **NUEVA**, con una opción elegida sobre el enunciado viejo. | **Corregido** (migración 19): el cliente manda `p_pregunta_id` (la que renderizó) y el servidor rechaza la respuesta si no coincide con la activa. |
| V6 | **INFO** | Permisos por columna: anon no puede leer `correcta/puntos/opcion` de la auditoría de trivia (solo el host). Correcto por diseño — el test de estrés lee con el host. | Sin acción. |

**Lo que ya era correcto (verificado, sin cambios):**
`sumar_puntos` atómico (`puntos = greatest(0, puntos + delta)`), anti doble-tap
por constraints únicos (trivia/supervivencia/rosco), `basta_declarar_completo`
(lock + re-check de fase), `basta_cerrar_ronda` (lock + recálculo idempotente
desde snapshot `puntos_base`), `basta_enviar` (upsert), `reanudar_relojes`
(pausa desplaza deadlines, nunca recalcula en cliente).

## 4. Integridad transaccional (10 usuarios al finalizar)

* **No hay bulk insert ni hace falta**: cada respuesta es una transacción
  individual y ATÓMICA (RPC = 1 INSERT + 1-2 UPDATEs chicos, conexión del pool
  liberada al terminar). Con 10 jugadores son ~10-50 transacciones por ronda:
  trivial para Postgres. Un bulk centralizado en el host rompería el anti-trampa
  (cada jugador debe autenticar su acción con su token en el momento exacto).
* La **idempotencia** está garantizada por constraints únicos
  (una respuesta por jugador/pregunta/letra/categoría), por `upsert`
  (basta) y por recálculo desde snapshot (basta).
* **Pérdida de datos**: los registros de jugadores viven en
  `registros_jugadores` desacoplados del ciclo de la sala (migración 13): el
  test verifica que sobreviven al `borrar_sala`. Los timeouts de red no
  pierden puntajes: la transacción falla completa o no (el jugador reintenta
  y el guard único evita el doble puntaje).
* El test mide ~194 RPCs concurrentes en una corrida: **37/37 aserciones OK**,
  sin errores 5xx ni desincronizaciones.

## 5. Verificación (base real)

```
scripts/test-concurrencia.mjs
FASE 1 Unión simultánea .......... 10/12 exitosas (2 duplicados rechazados)
FASE 2 Trivia .................... 10/10 aceptadas · doble-tap 10/10 rechazados
                                   suma RPC == suma BD
FASE 3 Supervivencia ............. 5 vivos +25 · 5 eliminados exactos
                                   procesar ×3 simultáneos idempotente
FASE 4 Basta ..................... 50/50 upserts · 1 solo "¡BASTA!" de 2
                                   carrera · cierre triple · recálculo estable
FASE 5 Rosco ..................... 4×10 correctas en paralelo · +400 exactos
                                   invariante anti-trabado tras carrera
FASE 6 Integridad ................ perfiles ×10 sobreviven al borrado
```

Re-ejecutar tras cada cambio de migraciones: `node scripts/test-concurrencia.mjs`.
