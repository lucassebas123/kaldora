# Kaldora 🎮 — Portal de juegos multijugador en vivo

Plataforma de juegos grupales en tiempo real sobre **kaldora.site**.
Un anfitrión proyecta el juego (PC/pantalla grande); los jugadores entran
desde el celular con **PIN + nickname**. **No hay servidor propio**: todo el
backend es Supabase (Postgres + Auth + Realtime) y toda la lógica de juego
vive en funciones SQL dentro de la base de datos.

Este documento explica **cómo está construido el proyecto**: tecnologías,
arquitectura, seguridad, herramientas y despliegue.

---

## 1. Qué es y cómo llegó hasta acá

| Versión | Qué fue |
| --- | --- |
| **v1 — "El Rosco"** | El primer juego: un rosco por **equipos con turnos** (estilo clásico de TV). Esquema completo en la migración `20260101000000_inicial.sql` (tablas de equipos, turnos, letras, etc.). |
| **v2 — "Kaldora"** | Evolución a **plataforma de 4 juegos masivos**: cada jugador juega desde su celular **al mismo tiempo** (sin turnos). El equipo reemplaza a la sala de juego con 1 a N jugadores, y se suman Trivia de Velocidad, Basta! y Supervivencia. Backend reescrito: `20260103000000_kaldora_v2.sql` (destruye el esquema v1 y deja la v2 limpia). |
| **v3** | Rosco pasa a modo **individual tipo Pasapalabra** (reloj total + pasapalabra por letra), se agrega **diccionario español + léxicos por categoría** para validar el Basta, y **perfil por correo** (quien ya jugó no se re-registra). |
| **v4 — login multicanal** | El jugador recurrente vuelve con **correo, celular o PIN de jugador** (`JUG-######` generado al registrarse y copiable). `registros_jugadores` pasa a historial con una fila **vigente** por identidad (correo/celular únicos); las RPCs `unirse_sala` y `entrar_con_identificador` resuelven registro y login. |

## 2. Stack de tecnologías

### Frontend
| Tecnología | Versión | Uso |
| --- | --- | --- |
| **React** | 19 | UI completa (SPA). |
| **Vite** | 8 | Build tool + dev server (`npm run dev`). |
| **React Router DOM** | 7 | Rutas públicas vs. protegidas (`BrowserRouter`). |
| **Tailwind CSS** | 3.4 (+ PostCSS + Autoprefixer) | Estilos utility-first; tema oscuro `#0B0616`. |
| **lucide-react** | — | Iconos. |
| **qrcode.react** | — | QR gigante para que los jugadores escaneen y entren. |
| **canvas-confetti** | — | Efectos de podio/celebración. |
| **Web Audio API** (nativa) | — | Música ambiente y efectos **100 % sintetizados en código** (0 KB de assets): `src/utils/musica.js` y `sonidos.js`. |
| **Canvas API** (nativa) | — | Fondo animado (`FondoAnimado.jsx`) y rosco SVG. |

### Backend (Supabase — sin servidor propio)
| Tecnología | Uso |
| --- | --- |
| **PostgreSQL** (Supabase) | Todas las tablas, índices y **toda la lógica de juego** en funciones PL/pgSQL. |
| **Supabase Auth** | Login del anfitrión (email/contraseña). |
| **Supabase Realtime** | 3 mecanismos combinados: `postgres_changes`, `presence` y `broadcast` (ver §4.5). |
| **RPCs SECURITY DEFINER** | Toda escritura pasa por funciones SQL que validan identidad y reglas. El cliente nunca escribe tablas. |
| **RLS + permisos por columna** | Las respuestas correctas nunca salen del servidor hacia clientes anon. |
| **Supabase CLI** | Migraciones versionadas (`supabase db push`). |

### Herramientas de desarrollo
| Herramienta | Uso |
| --- | --- |
| **oxlint** | Linter (reglas de hooks de React activas). |
| **Playwright** | Test de UI con Chromium real. |
| **ws** | Cliente WebSocket para el test E2E de Realtime desde Node. |
| **an-array-of-spanish-words** (MIT) | Fuente del diccionario de 600k+ formas que se **siembra en la tabla `palabras`** del servidor (no se importa en el cliente). |
| **Vercel** | Hosting + dominio (SPA rewrites). |
| Node.js ≥ 18 + npm | Runtime del build y de los scripts de prueba. |

## 3. Arquitectura general

```
┌─────────────────────────────┐         ┌──────────────────────────────────┐
│  SPA React (Vercel)         │  HTTPS  │        SUPABASE                  │
│                             │────────▶│  ┌────────────────────────────┐  │
│  Jugador (celular)          │  REST   │  │ Postgres                   │  │
│   ↕ Realtime (WSS)          │         │  │  tablas + RLS + RPCs       │  │
│  Anfitrión (PC proyectado)  │◀────────│  │  (SECURITY DEFINER)        │  │
│                             │ realtime│  └────────────────────────────┘  │
└─────────────────────────────┘  (WSS)  │  Auth + Realtime (pub/sub)       │
                                        └──────────────────────────────────┘
```

* **Un solo origen de verdad**: Postgres. El estado del juego (`salas.juego`,
  un `jsonb` volátil) y los puntajes viven en la base.
* **El anfitrión es el "director de orquesta"**: dispara rondas y re-publica
  la instantánea del estado por broadcast; los celulares se mutan solos.
* **Los clientes son "tontos"**: envían acciones (RPC) y pintan lo que les
  llega. Ninguna regla de puntaje se calcula en el cliente.

### Rutas

```
/                    -> Landing pública (PIN gigante + nickname)
/jugar/:codigo       -> HUB del jugador: sala de espera + mutación por juego
/admin/login         -> Login del anfitrión (Supabase Auth)
/admin               -> Dashboard: crear/listar salas
/admin/sala/:id      -> Centro de control: QR + PIN, selector de juego,
                        proyección + moderación por juego, podio/revancha
```

## 4. El backend (Supabase) en detalle

### 4.1 Tablas principales

| Tabla | Qué guarda |
| --- | --- |
| `salas` | PIN de 6 dígitos único (`CHECK codigo ~ '^[0-9]{6}$'`), dueño (`id_anfitrion` → `auth.users`), estado (`en_espera/jugando/pausado/finalizado`), juego actual (enum `juego_tipo`) y `juego jsonb` con el estado volátil de la ronda (letra activa, pregunta, deadline, etc.). |
| `jugadores` | Nickname único por sala (≤ 20, insensible a mayúsculas/tildes), avatar, color, **puntos ≥ 0**, racha, eliminado y (v3) `rosco jsonb` con el estado individual del rosco. **Sin secretos ni PII** (ver §4.5). |
| `sesiones_jugador` | **Tabla 100 % privada**: token secreto de 16 bytes (`gen_random_bytes`) por jugador. Autentica cada acción. Sin RLS que la exponga y sin permisos para clientes. |
| `preguntas` (rosco) | Banco A–Z: letra, pregunta, respuesta. |
| `rosco_respuestas` | Auditoría: una respuesta por jugador y letra. |
| `preguntas_trivia` / `trivia_respuestas` | Banco de opciones (2–4) + índice correcto / respuestas por jugador y pregunta. |
| `categorias_basta`, `respuestas_basta` | Categorías (con `clave_lexico`) y las palabras de cada ronda (`valida`, `unico`, `puntos`, `existe`, `corresponde`). |
| `preguntas_supervivencia` / `supervivencia_respuestas` | Banco V/F y auditoría de rondas. |
| `palabras` (v3) | Diccionario español + lunfardo argentino (**600k+ formas**, generado desde `an-array-of-spanish-words`, filtrado y deduplicado). |
| `lexico_categorias` (v3) | Léxico por categoría (valida que la palabra "corresponda" a la categoría). |
| `admins_autorizados`, `registros_jugadores` | Gestión de anfitriones (con roles) e **historial persistente** de datos de jugadores (nombre, apellido, teléfono, correo, `pin_jugador`) — sobrevive a la salida y al borrado de salas; una sola fila **vigente** por identidad alimenta el login multicanal. |

### 4.2 Identidades (2 mundos)

* **Anfitrión** = usuario real de **Supabase Auth** (`authenticated`). Cada
  sala queda ligada a su `auth.uid()` y los RPCs de host validan
  `auth.uid() = salas.id_anfitrion`. **No hay tokens de host compartidos.**
* **Jugador** = cliente **anon**. Al unirse, el servidor genera un **token
  secreto** (hex de 16 bytes) que se guarda en `sesiones_jugador` (privada) y
  en `localStorage` del dispositivo (`kaldora_jugador`). Cada RPC de juego
  envía ese token y el servidor lo valida. El token **nunca** viaja por
  Realtime ni por lecturas REST.
* **Login multicanal** (v4): el recurrente se identifica con **correo,
  celular o su PIN de jugador** (`entrar_con_identificador`). El PIN
  (`JUG-######`) lo genera el servidor en el registro, se muestra una vez
  para copiar al portapapeles y vuelve en cada registro posterior. La tabla
  de registros guarda **una fila vigente por identidad** (correo y celular
  únicos, case/dígitos-insensibles) y rota las anteriores como historial; así
  un correo tipeado mal no deja al jugador afuera (lo rescatan el celular o
  el PIN). `perfil_por_correo` sigue precargando datos en el registro.

### 4.3 RPCs SECURITY DEFINER (toda la lógica de juego)

~40 funciones SQL expuestas como RPC. El cliente **nunca** hace
`INSERT/UPDATE` sobre tablas. Ejemplos:

* **Sala/host**: `crear_sala`, `mis_salas`, `borrar_sala`, `seleccionar_juego`,
  `pausar_partida`, `reanudar_partida`, `terminar_partida`, `volver_al_lobby`,
  `expulsar_jugador`, `cargar_banco`, gestión de admins.
* **Jugador**: `unirse_sala` (nickname único por sala, devuelve token +
  `pinJugador`), `entrar_con_identificador` (login por correo/celular/PIN),
  `salir_sala`, `perfil_por_correo`.
* **Rosco (v3, individual)**: `rosco_iniciar`, `rosco_enviar`, `rosco_pasar`,
  `rosco_cerrar`, `rosco_estado`. Internas: `rosco_letra_siguiente`
  (orden circular A–Ñ, salta a las pendientes), `rosco_avanzar_interno`,
  `rosco_ctx`. Validación de respuesta en el servidor: **normalización**
  (minúsculas, sin tildes ni puntuación) + **distancia de Levenshtein**
  tolerante. Puntaje: **+100 acierto / −50 error / pasapalabra 0**.
* **Trivia**: `trivia_siguiente` (fija deadline), `trivia_responder`. El
  puntaje 1000 → 0 se derrite **ms a ms** contra el deadline fijado por el
  servidor; rachas **x2** (3 aciertos) y **x3** (5).
* **Basta**: `basta_iniciar_ronda`, `basta_enviar`, `basta_declarar_completo`
  (dispara el deadline letal de **10 s**), `basta_cerrar_ronda` (cierra y
  puntúa 10/5 según la **decisión del anfitrión**: única/repetida/tachada.
  El **diccionario + léxicos por categoría** solo calculan avisos visuales —
  existe/corresponde — para que el host revise, no quitan puntos),
  `basta_toggle_valida` (moderación manual; si valida a mano una palabra
  inexistente, **el diccionario la aprende**).
* **Supervivencia**: `supervivencia_siguiente`, `supervivencia_responder`,
  `supervivencia_procesar` (elimina a quien erró o no respondió).

Helpers internos (sin `EXECUTE` para clientes): autenticación de host/jugador
por token, normalización de palabras, orden del abecedario con Ñ, etc.

### 4.4 RLS estricta + permisos por columna

* El rol `anon` solo puede `SELECT` **columnas públicas** específicas.
* Las columnas con las respuestas correctas — `preguntas.respuesta`,
  `preguntas_trivia.indice_correcto`, `preguntas_supervivencia.es_verdadera` —
  **jamás llegan al cliente anon** (se revocan a nivel de columna). Solo el
  anfitrión autenticado puede leerlas (por eso puede editar los bancos).
* `sesiones_jugador`, `palabras`, `lexico_categorias`, etc.: sin políticas
  para clientes (solo las RPCs las tocan).

### 4.5 Realtime (el corazón del tiempo real)

Un **único canal WSS por sala** (`sala:{id}`) transporta 5 cosas a la vez
(`src/hooks/useSalaRealtime.js`):

1. **`postgres_changes`** sobre `salas` y `jugadores` → estado global y
   puntajes en vivo. Solo esas 2 tablas están publicadas (sin secretos).
   *Importante*: el filtro no se pide al servidor (la entrega filtrada es
   intermitente); se filtra **en el cliente**.
2. **Presence** → quién está conectado ahora (jugadores y anfitrión), con
   icono/color para la UI.
3. **Broadcast `ev`** → eventos de alta frecuencia **sin escribir la base**:
   respuestas voladas, "¡completé el Basta!", avisos del host, instantáneas
   de estado. Miles de eventos/s a costo cero.
4. **Broadcast `hora_req`/`hora_res`** → **sincronización de reloj**: cada
   celular mide su deriva contra el anfitrión (ping/pong con descarte de
   muestras con RTT > 1.5 s y suavizado exponencial 0.3/0.7). Así los
   cuenta-atrás de 15 s / 20 s / 10 s corren **parejos en todos los
   dispositivos**.
5. **Resiliencia**: polling de respaldo cada **3 s** + "vigilante" que
   re-sincroniza y reconstruye el canal si queda mudo > 12 s. El juego
   funciona aunque Realtime entregue tarde o nunca (los relojes son por
   **deadline absoluto** fijado por el servidor, no por ticks).

El hook `useCuentaAtras` dibuja el countdown a 20 fps desde el
`fin` (timestamptz del servidor) + `offsetReloj`, con soporte de pausa sin
perder el restante.

## 5. El frontend (React + Vite)

```
src/
├── main.jsx / App.jsx            # Router: rutas públicas vs protegidas
│                                 #   (RutaProtegida usa useAdminAuth: si no hay
│                                 #    sesión de Supabase Auth → /admin/login)
├── supabaseClient.js             # Cliente único (realtime: 30 ev/s)
├── api/kaldoraApi.js             # ÚNICA capa de acceso al backend: ~40 RPCs
│                                 #   + sesión del jugador en localStorage
├── hooks/
│   ├── useSalaRealtime.js        # Canal único: postgres_changes, presence,
│   │                             #   broadcast, reloj, vigilante, polling
│   ├── useCuentaAtras.js         # Countdown por deadline + offset de reloj
│   └── useAdminAuth.js           # Sesión Supabase Auth del anfitrión
├── game/constantes.js            # Reglas de los 4 juegos (espejo del servidor)
├── pages/
│   ├── Landing.jsx               # Portal público: registro (con PIN de
│   │                             #   jugador copiable) + login multicanal
│   ├── SalaJugador.jsx           # HUB: muta a la vista del juego activo
│   ├── jugador/                  # RoscoJugador, TriviaJugador, BastaJugador,
│   │                             #   SupervivenciaJugador (+ espectador rojo)
│   └── admin/
│       ├── AdminLogin.jsx        # Login (Supabase Auth)
│       ├── AdminPanel.jsx        # Dashboard: crear/listar/borrar salas
│       ├── AdminSala.jsx         # Centro de control: lobby (QR+PIN) →
│       │                         #   jugando → pausado → podio/revancha
│       ├── BancoPreguntas.jsx    # Editor de bancos (rosco/trivia/supervivencia)
│       └── paneles/              # PanelRosco, PanelTrivia, PanelBasta,
│                                 #   PanelSupervivencia (proyección + moderación)
├── components/                   # FondoAnimado (canvas), Rosco (SVG circular),
│                                 #   Podio, RankingJugadores, AnilloProgreso,
│                                 #   AvatarChip, HeaderJugador, BotonMusica,
│                                 #   AvisoActualizacion (detecta pestaña con
│                                 #   bundle viejo y ofrece recargar)
└── utils/
    ├── musica.js                 # Música ambiente sintetizada (Web Audio),
    │                             #   un loop por contexto, mute persistente
    ├── sonidos.js                # SFX sintetizados: acierto, fallo,
    │                             #   pasapalabra, tic-tac, alarma
    ├── importador.js             # Importador universal de bancos: pega texto
    │                             #   (PDF/Word/web), CSV/TSV, JSON, SQL o texto
    │                             #   libre → previsualiza → carga vía RPC
    └── formato.js                # Formateo de tiempos
```

**Flujo de una partida (ejemplo Trivia):**
1. El host lanza el juego → RPC `seleccionar_juego` → `salas.juego_actual`
   cambia → los celulares se mutan solos (postgres_changes).
2. El host pide pregunta → `trivia_siguiente` fija en `salas.juego` la
   pregunta y el **deadline absoluto** → todos corren el mismo reloj.
3. Cada jugador responde → RPC `trivia_responder` (token + opción) → el
   servidor puntúa contra el deadline (1000 decreciente + racha).
4. El host re-publica la instantánea (sala + jugadores) por **broadcast** →
   actualización instantánea en todos los celulares sin esperar WAL.
5. Podio → revancha o volver al lobby.

## 6. Los cuatro juegos

| Juego | Mecánica | Puntaje |
| --- | --- | --- |
| **El Rosco** ⭕ (v3: individual) | Abecedario circular A–Ñ. Reloj **total continuo** (120/180/300 s). Cada letra es un pasapalabra: responder, pasar o cerrar; al terminar la pasada se vuelve a ciclar **solo por las pendientes**. Validación server-side (normalización + Levenshtein). | **+100** acierto, **−50** error, pasapalabra 0 |
| **Trivia de Velocidad** ⚡ | Base de **1000 pts** que se derrite ms a ms durante **20 s** contra el deadline del servidor. | Rachas: 3+ → **x2**, 5+ → **x3** |
| **Basta!** 🎯 | Letra común + 5 categorías. El primero en completar dispara la cuenta regresiva **letal de 10 s**. Al cerrar, el diccionario (600k palabras) y los léxicos marcan palabras dudosas como **avisos** (naranja/ámbar), pero el puntaje lo decide el anfitrión: única **+10**, repetida **+5**, tachada 0. Si re-valida a mano una palabra inexistente, el diccionario la aprende. | 10 / 5 / 0 |
| **Supervivencia** 💀 | Verdadero/Falso a eliminación súbita: un error (o no responder) te elimina y pasás a espectador (pantalla roja). | **+25** por acierto |

Las constantes de reglas viven en `src/game/constantes.js` como **espejo
exacto** de las RPCs del servidor (solo para pintar la UI; el server manda).

## 7. Migraciones (historia del esquema)

```
supabase/migrations/
├── 20260101000000_inicial.sql        # v1: rosco por equipos/turnos (histórica)
├── 20260102000000_seed.sql           # Preguntas del rosco
├── 20260103000000_kaldora_v2.sql     # Esquema v2: 10 tablas, 36 funciones,
│                                     #   RLS, realtime, tipos, índices
├── 20260104000000_seed_kaldora.sql   # Contenido trivia/basta/supervivencia
├── 20260105000000_hotfix_basta.sql   # Corrección de la ronda letal
├── 20260106000000_admins_registro_bancos.sql  # admins_autorizados +
│                                     #   registros_jugadores + carga de bancos
├── 20260107000000_gestion_admins.sql # Roles de administrador
├── 20260108000000_kaldora_v3.sql     # Rosco individual + diccionario +
│                                     #   perfil por correo
├── 20260109000000_diccionario.sql    # 600k+ palabras (an-array-of-spanish-words)
├── 20260110000000_lexicos.sql        # Léxico por categoría del Basta
├── 20260111000000_hotfix_rosco_ctx.sql # Corrección de contexto del rosco
├── 20260112000000_hotfix_basta_puntaje.sql # Basta: diccionario avisa, host puntúa
├── 20260113000000_registro_persistente.sql # Registro de jugadores sobrevive a salas/borrados
├── 20260114000000_auditoria_concurrencia.sql # Locks anti race conditions (ver docs/auditoria-tecnica.md)
├── 20260115000000_carga_masiva_v2.sql # Batch insert de una sentencia + sanitización XSS + tope 5000
├── 20260116000000_endurecimiento.sql  # Seguridad: banco `preguntas` fuera de Realtime,
│                                      #   grants de escritura sobre PII revocados,
│                                      #   topes anti-abuso (200 jugadores/sala,
│                                      #   50 salas/host), validación icono/color
└── 20260117000000_login_multicanal.sql  # v4: PIN de jugador único, fila vigente
                                        #   por identidad (correo/celular únicos),
                                        #   `unirse_sala` devuelve PIN y
                                        #   `entrar_con_identificador` (login)
```

Se aplican con **Supabase CLI**: `npx supabase link --project-ref <REF>` y
`npx supabase db push` (las migraciones configuran solas la publicación de
Realtime y los permisos).

## 8. Seguridad — resumen

* El anon solo **lee** columnas públicas y dispara RPCs con su token secreto.
* **Cero confianza en el cliente**: puntajes, turnos, deadlines y validación
  de respuestas se calculan **siempre** en el servidor.
* Respuestas correctas **nunca** salen del servidor hacia clientes anon
  (RLS + permisos por columna).
* Los tokens no se publican por Realtime (tabla separada, sin publicación).
* Los RPCs de host exigen sesión de Supabase Auth válida **y dueña** de la sala.
* El estado de juego vive en un solo `jsonb` (`salas.juego`): una transición
  = un solo evento Realtime, sin tormentas de writes.

## 9. Puesta en marcha local

```bash
npm install
cp .env.example .env        # completar VITE_SUPABASE_URL,
                            #   VITE_SUPABASE_ANON_KEY, VITE_APP_URL
npm run dev                 # http://localhost:5173

# Base de datos (una sola vez):
npx supabase login
npx supabase link --project-ref <PROJECT_REF>
npx supabase db push
```

## 10. Scripts

```bash
npm run dev                     # dev server (Vite)
npm run build                   # build de producción (Vite)
npm run lint                    # oxlint
node scripts/test-logica.mjs    # pruebas unitarias de la lógica pura
                                #   (rachas, puntajes, formatos)
node scripts/test-importador.mjs  # pruebas del IMPORTADOR de bancos (parsing
                                #   de los 3 formatos, carga parcial con
                                #   "Línea 42", re-evaluación por modo,
                                #   consolidación sin desindexar, chunks)
node scripts/test-e2e.mjs       # E2E contra Supabase REAL: simula anfitrión
                                #   + jugadores, los 4 juegos completos, el
                                #   login multicanal (PIN/correo/celular) y
                                #   controles de seguridad (anon no puede
                                #   crear salas, leer respuestas ni escribir
                                #   tablas; Realtime entrega). Usa `ws`.
node scripts/test-concurrencia.mjs  # ESTRÉS: 10 jugadores simultáneos por los
                                #   4 juegos (unión, doble-tap, carreras de
                                #   BASTA/procesar/enviar+pasar, integridad
                                #   de puntos y perfiles). Ver
                                #   docs/auditoria-tecnica.md.
node scripts/test-ui.mjs        # UI con Playwright (Chromium real): landing,
                                #   login, lanzar cada juego, mutación del
                                #   jugador y cero errores de consola.
```

## 11. Despliegue (Vercel)

1. `npm run build` sin errores.
2. `vercel.json` reescribe cualquier ruta a `index.html` (SPA fallback para
   React Router).
3. Variables en Vercel: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
   `VITE_APP_URL` (esta última arma el QR de la sala).
4. Aplicar migraciones en Supabase (`supabase db push`); Realtime queda
   configurado por ellas.
5. Dominio: **kaldora.site**.
