# Operación y resiliencia — KALDORA

> Cómo dejar la plataforma lo más segura y estable posible **en el plan Free
> de Supabase**, qué se midió, cómo volver atrás y qué hacer el día del evento.

---

## 1. Punto de retorno (rollback)

| Capa | Cómo volver atrás |
| --- | --- |
| **Frontend (Vercel)** | Vercel guarda cada deploy inmutable. Dashboard → Deployments → elegir el deploy anterior → **Instant Rollback**. No se toca código. Deploy estable previo al hardening: `el-rosco-piz2o9dy6-proyectos-p.vercel.app`. Deploy con las mejoras (2026-09-12): `el-rosco-b06xz0k73-proyectos-p.vercel.app`. |
| **Código** | Git tag `punto-retorno-pre-hardening` (commit `7a66066`) = estado estable previo a todo esto. |
| **Base de datos** | No hay rollback automático (Free no tiene backups ni PITR). Se restaura desde un dump: `node scripts/restore.mjs --dir backups/<fecha>`. |

### Respaldo y restauración

```bash
npm run backup                     # backups/<fecha>/ (JSON + manifest con sha256)
node scripts/restore.mjs --dir backups/<fecha>   # restaura bancos, léxicos y registros
```

* `scripts/backup.mjs` exporta **datos irremplazables** vía REST con la
  service_role key (no necesita Docker). `palabras` (636.637 filas) no se
  exporta: se regenera con la migración `20260109000000_diccionario.sql`.
* `scripts/restore.mjs` verifica el sha256 de cada archivo antes de importar y
  valida los conteos al final. Probado contra staging: **1.402/1.402 filas**.
* **Las migraciones reconstruyen la base desde cero** (se corrió el historial
  completo v1→v25 en un proyecto vacío; se corrigió una colisión de políticas
  entre la v1 y la v2 que lo impedía).

### Proyecto espejo (staging)

* `kaldora-staging` (`bzkyemjmmiprlnsbtian`, us-east-2) refleja producción.
* Credenciales en `.env.staging` (ignorado por Git, permisos 600).
* Todos los tests aceptan `ENTORNO=staging` y corren contra él sin tocar
  producción.
* Única diferencia: staging tiene el **signup público habilitado** (para crear
  hosts de prueba por Admin API). Producción lo tiene deshabilitado.

---

## 2. Anti-pausa del plan Free

Supabase pausa los proyectos Free tras ~7 días sin actividad. En pleno evento
eso es downtime garantizado. `scripts/keepalive.mjs` hace 2 lecturas REST
mínimas; el workflow `.github/workflows/keepalive.yml` lo corre todos los días
a las 12:10 UTC.

* Requiere dos secrets del repo: `VITE_SUPABASE_URL` y
  `VITE_SUPABASE_ANON_KEY` (Settings → Secrets and variables → Actions).
* También se puede ejecutar a mano: `npm run keepalive`.

---

## 3. Presupuesto de Realtime (medido, no estimado)

Medición con `scripts/test-carga-3-salas.mjs`: **3 salas × 20 jugadores**
(63 clientes), los 4 juegos y sus transiciones, contando como Supabase: 1
evento = 1 mensaje entregado a 1 cliente.

| Métrica | Antes (código original) | Después (optimizado) |
| --- | --- | --- |
| Reposo (ping de reloj) | **874 msg/s** | **~1-5 msg/s** |
| Trivia (ronda completa 3 salas) | ~1.300+ / pico 2.400/s | ~2.500 eventos (~329/s en 8 s) |
| Basta (ronda completa) | pico 2.400/s | ~2.650 eventos (~322/s en 8 s) |
| Rosco (reset + respuestas) | ~5.300 eventos | ~5.200 eventos (~627/s en 8 s) |
| Fan-out entre salas | ~92 % de `jugadores` era de otras salas | **0 eventos ajenos** |
| Sends caídos a REST (canal cerrado) | **746** | **0** |
| Presupuesto Free (2M/mes) solo lobby | 0,6 h/mes | **~397 h/mes** |

Límites del plan Free: **100 msg/s** (promedio móvil de 1 minuto),
200 conexiones, 2M mensajes/mes. Un evento de 2 h a ritmo intenso consume
~300-700k mensajes; el lobby ya no consume casi nada.

**Palancas aplicadas** (todas validadas contra la base real):
1. `postgres_changes` **con filtro server-side por sala** (0 pérdidas, 0 ajenos).
2. Reloj por **RPC REST** (`hora_servidor`): 1 calibración al empezar la
   partida + refresco cada 5 min. Cero mensajes de Realtime.
3. Polling de respaldo más lento fuera de partida (9 s en lobby, 3 s jugando).
4. `basta_palabra` con throttle de 1,2 s por jugador (aviso cosmético).
5. Rosco: **un solo UPDATE por respuesta** (estado + puntos juntos).
6. Reutilización de fila al re-registrarse en la misma sala (sin fantasmas).

> Con 3 salas a ritmo intenso sostenido el promedio puede rozar los 100 msg/s.
> Por eso: si se espera un evento muy cargado o varios simultáneos, el plan
> **Pro** (500 msg/s, sin pausa, backups diarios) elimina el riesgo de una vez.
> Aun sin Pro, si Realtime corta un canal, la app **no pierde puntajes**: el
> polling y los deadlines del servidor re-sincronizan solos.

---

## 4. Robustez de red del cliente

* **Reintentos de red** en `kaldoraApi.js`: los fallos tipo `fetch failed` /
  timeout se reintentan 2 veces con backoff + jitter. Los errores de negocio
  ("ya respondiste", "la letra cambió") se propagan para conciliar estado.
* **Aviso de conexión degradada**: si el canal queda mudo > 12 s o el
  dispositivo queda sin red, aparece un banner ("Reconectando…") sin bloquear
  el juego.
* **Recuperación**: al reconectar, el polling (3 s en partida) re-trae sala y
  jugadores; el rosco restaura su estado con `rosco_estado`; el host
  re-publica la instantánea por broadcast.
* **Test de caos** (`node scripts/test-caos.mjs`): 12/12 verificaciones con
  Realtime caído en medio de una rotación de pregunta, doble-tap y
  recuperación por instantánea.

---

## 5. Seguridad auditada (v2)

* **Anti fuerza bruta por IP** (`intentos_acceso` + `x-forwarded-for`):
  solo se cuentan los **fallos** (PIN inexistente, identificador
  desconocido), así una sala con IP compartida (NAT del Wi-Fi) no se bloquea.
  Los umbrales viven en la tabla `limites_acceso` y se ajustan con un UPDATE
  (sin tocar funciones):

  | Acción | Umbral | Qué cuenta |
  | --- | --- | --- |
  | `pin_fallos` | 60 / 5 min | PIN de sala que no existe |
  | `login_fallos` | 40 / 5 min | correo/celular/PIN de jugador sin registro |
  | `perfil_fallos` | 150 / 5 min | correo tipeado que no está registrado |

  * Detalle de implementación: el fallo devuelve error "suave"
    (`{error}` en el JSON) para que el registro de intentos **commitee**; el
    wrapper JS lo convierte en excepción normal.
* **PII mínima**: `perfil_por_correo` solo devuelve `existe`, `nombre` y
  `nickname` (antes apellido y teléfono a cualquiera que probara un correo).
* **Columnas**: `anon` ya no puede leer `salas.id_anfitrion`.
* **Topes de entrada**: palabra de Basta y respuesta de Rosco ≤ 60 caracteres;
  opción de Trivia 0-3.
* **Headers** (Vercel): CSP, HSTS, X-Frame-Options DENY, COOP same-origin,
  Permissions-Policy.
* Verificación: `ENTORNO=staging node scripts/test-seguridad.mjs` → **14/14**.

---

## 6. Runbook del día del evento

### Antes (el día previo)
- [ ] `npm run keepalive` (proyecto despierto).
- [ ] `npm run backup` (snapshot por si hay que restaurar).
- [ ] `ENTORNO=staging npm run verificar` en verde.
- [ ] En cada sala: cargar el **WhatsApp de verificación** (vista privada
      `/admin/sala/:id/verificaciones` en el celular del anfitrión, o
      `VITE_WHATSAPP_ANFITRION` como respaldo global).
- [ ] Render/PC del host con la sala creada, batería/enchufe y la pestaña
      sin dormir.
- [ ] Router del lugar: idealmente red 5 GHz, host por cable si se puede.

### Durante
- [ ] Dashboard de Supabase → **Reports → Realtime**: mirar conexiones y
      mensajes/s. Si aparece un pico sostenido cerca de 100/s, bajar el ritmo
      de rondas.
- [ ] Verificaciones: los jugadores mandan su código por WhatsApp; confirmar
      desde la vista privada del celular (la TV solo muestra contador y ✅).
- [ ] Si el banner "Reconectando…" aparece en varios celulares: los puntajes
      están a salvo en el servidor; esperar unos segundos o recargar.
- [ ] No crear/borrar salas de prueba durante el evento.

### Después
- [ ] `npm run backup`.
- [ ] Revisar **Reports → Realtime** del día y anotar el consumo mensual.
- [ ] Revisar `Database → Logs` por errores.

### Si algo sale mal (decisión rápida)
| Síntoma | Acción |
| --- | --- |
| Un solo celular raro | Recargar la página; la sesión se restaura. |
| Realtime lento para todos | Esperar: el polling mantiene el juego. No pausar. |
| Proyecto pausado (no responde nada) | Dashboard → Restore project; luego `npm run keepalive`. |
| Datos corruptos | Detener el evento → `node scripts/restore.mjs --dir backups/<fecha>` (avisar al equipo). |
| Frontend roto tras un deploy | Vercel → Deployments → Rollback al anterior. |

---

## 7. Verificación (antes de cada deploy)

```bash
npm run lint                        # oxlint (0 warnings)
npm run build                       # build de producción
npm run auditar:api                 # auditoría estática frontend ↔ SQL
ENTORNO=staging LIVE=1 npm run auditar:api   # + inventario real (drift)
node scripts/test-logica.mjs        # lógica pura
node scripts/test-importador.mjs    # importador de bancos
ENTORNO=staging npm run test:seguridad
ENTORNO=staging npm run test:caos
ENTORNO=staging npm run test:e2e
ENTORNO=staging npm run test:concurrencia
ENTORNO=staging npm run test:carga   # 3 salas × 20 · métricas de Realtime
```

`npm run verificar` encadena lint + lógica + importador + seguridad + caos +
e2e + concurrencia (la carga se corre aparte por su duración).

Resultados de referencia (2026-09-15, staging): lógica 17/17 · importador
34/34 · seguridad 14/14 · caos 12/12 · e2e 94/94 · concurrencia 37/37.
