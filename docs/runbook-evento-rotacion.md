# Runbook — Evento con rotación de salas (2 TVs · 15 por sala · Rosco + desempate)

> **Alcance:** este documento es el **delta** para el formato de evento por
> rotación. El checklist genérico, el presupuesto de Realtime, el anti-pausa y
> la tabla de decisión ante incidentes viven en
> [operacion.md](operacion.md) (§2, §3 y §6) y **no se repiten acá**.
>
> Formato: **2 televisores**, **15 jugadores por sala**, **~5 h**, **5 cuentas
> de anfitrión** rotando, plan **Free** de Supabase, monitor externo de
> keep-alive activo. Cada grupo juega **Rosco** y luego un **desempate** en una
> **sala nueva**. La sala del Rosco queda `finalizado` como registro.
>
> Insumos de este runbook: [bancos/](bancos/), [sql/ajustes-evento.sql](sql/ajustes-evento.sql),
> [planillas/control-salas.csv](planillas/control-salas.csv).

---

## 1. Formato y reglas del evento

| Regla | Detalle |
| --- | --- |
| Juego 1 | **Rosco** (reloj total por jugador; el host no avanza letras). |
| Cierre del Rosco | Botón **Terminar** → podio. Anotar el **top 3** en la planilla. |
| Registro | La sala del Rosco se deja **`finalizado`** (puntos y auditoría intactos en la base). **Nunca tocar "Lobby"** en esa sala. |
| Juego 2 (desempate) | **Sala nueva**, idealmente con **solo los finalistas** (con 1 alcanza para lanzar). Partida limpia, sin arrastrar puntos. |
| Cuentas | Rotar las 5 cuentas de anfitrión entre ciclos (ver §4). |
| Salas | No borrar durante el evento si se quiere el registro; limpiar en T+0 (§6). |

---

## 2. T-1 — Día anterior

- [ ] **Bancos cargados y verificados.** Camino automático (idempotente, no
      duplica): `npm run importar:bancos` (`--dry` para previsualizar;
      `ENTORNO=staging` para el espejo). Alternativa manual, desde
      `/admin` → sala → **Banco de preguntas**:
      - `bancos/trivia.json` (≥200 preguntas; índice base 0)
      - `bancos/supervivencia.json` (≥100 frases V/F)
      - `bancos/rosco.json` (3–5 respuestas por letra, A–Z + Ñ)
      - **Spot-check humano:** revisar 15–20 ítems al azar por banco (el
        contenido es generado; corregir cualquier dato dudoso). `descartes: 0`.
- [ ] **Umbrales anti-bloqueo:** ejecutar el bloque de subida de
      [sql/ajustes-evento.sql](sql/ajustes-evento.sql) en el SQL Editor y
      verificar con el `select` del mismo archivo.
- [ ] **Keep-alive y proyecto activo** (ver `operacion.md` §2):
      `npm run keepalive`, últimos runs del workflow `keepalive` en verde y
      monitor externo (cron-job.org / UptimeRobot) con historial exitoso.
      Dashboard → proyecto **Active** (si está pausado: *Resume project*).
- [ ] **Backup fresco:** `npm run backup` (los respaldos locales llevan PII:
      no se suben a Git).
- [ ] **Dry-run en staging** (no toca producción):
      `ENTORNO=staging npm run verificar` y
      `ENTORNO=staging SALAS=2 FILTRO_SALA=1 node scripts/test-carga-3-salas.mjs 15`.
      Cronometrar un ciclo completo en la medición para saber cuántas salas se
      crean por TV.
- [ ] **Deploy congelado:** no deployar ni mergear a producción durante el
      evento. Rollback disponible: Vercel → Deployments → *Instant Rollback*.
- [ ] **WhatsApp de verificación:** cargarlo en cada sala
      (`/admin/sala/:id/verificaciones` desde el celular) o definir
      `VITE_WHATSAPP_ANFITRION`, y probar el flujo completo una vez.
- [ ] **Dispositivos:** PCs enchufadas, sin suspensión ni salvapantallas,
      pestaña visible; ideal cable o 5 GHz. **Silenciar la música** en las 2
      PCs (evita el golpe del scheduler al volver de pestaña congelada).
      Cargadores/regletas para celulares; hotspot de respaldo.

---

## 3. Guion del ciclo (por grupo de 15)

1. **Crear sala** con la cuenta que toque (planilla: TV + cuenta).
2. Mostrar **QR/PIN**; entran los 15 (todavía `en_espera`).
3. Elegir **Rosco** → **¡Lanzar!**
4. Al agotarse el tiempo de cada jugador: botón **Terminar** → **podio**.
5. Anotar **1º, 2º y 3º** (y puntos) en
   [planillas/control-salas.csv](planillas/control-salas.csv).
6. **Dejar la sala `finalizado`** (registro). No tocar "Lobby".
7. **Crear sala nueva** para el desempate; que entren **solo los finalistas**
   (recomendado: los 3). Guardar el código en la planilla.
8. Elegir el juego 2 (**Trivia** es el más objetivo y rápido; **Supervivencia**
   con 3 es el más dramático; evitar **Basta** si el host modera solo) → **¡Lanzar!**
9. **Terminar** → podio → anotar **ganador final**.
10. Siguiente grupo.

> Alternar TVs: si un grupo acaba el Rosco, esperar **60–90 s** antes de que la
> otra TV lance, para no sumar ráfagas de Realtime.

---

## 4. Reglas de oro

1. **Nunca "Lobby" sobre una sala de Rosco**: borra puntos y respuestas
   (`volver_al_lobby`) y se pierde el registro. El registro es la sala
   `finalizado`.
2. **Un dispositivo por jugador** y avisar que guarde su **`JUG-######`**: con
   eso reingresa rápido en cada sala nueva.
3. **No crear/borrar salas de prueba** durante el evento.
4. **Escalonar** los arranques de Rosco entre TVs (60–90 s).
5. Las 5 cuentas se rotan; anotar en la planilla cuál usa cada TV.
6. No reimportar los bancos (duplican preguntas). Si hay que corregir, editar
   desde el editor del banco.

---

## 5. Durante el evento

- Mirar **Reports → Realtime** cada tanto: si el promedio se sostiene cerca de
  **100 msg/s**, escalonar más los lanzamientos (los puntajes no se pierden).
- **"Reconectando…"** en varios celulares: esperar sin pausar; el polling (3 s)
  y los deadlines del servidor re-sincronizan (`operacion.md` §4).
- **Alguien no puede entrar** (muchos PINs fallidos en poco tiempo): esperar la
  ventana o subir el umbral al instante con el bloque de `sql/ajustes-evento.sql`.
- **Aviso rojo de RPC fallida** en el panel: reintentar la acción; el estado
  vive en el servidor.
- Ante cualquier incidente, usar la tabla de decisión rápida de
  `operacion.md` §6 (recargar un celular raro, esperar Realtime lento, etc.).

---

## 6. T+0 — Después del evento

- [ ] `npm run backup`.
- [ ] Revisar **Reports → Realtime** y **Billing → Usage** (pico, mensajes del
      mes, egress) y anotarlo.
- [ ] Revisar `Database → Logs` por errores.
- [ ] **Limpiar salas por cuenta** (el tope son 50 salas *históricas* por
      anfitrión): borrar las viejas desde `/admin` dejando, si se quiere, las
      últimas con ganadores.
- [ ] **Revertir umbrales** con el bloque final de
      `sql/ajustes-evento.sql` (opcional; recomendado).
- [ ] Completar la columna `observaciones` de la planilla (incidentes y tiempos).

---

## 7. Anexos

| Insumo | Uso |
| --- | --- |
| [bancos/trivia.json](bancos/trivia.json) | Importar en el **Banco de preguntas** (formato JSON, índice 0-based). |
| [bancos/supervivencia.json](bancos/supervivencia.json) | Importar en el banco de Supervivencia. |
| [bancos/rosco.json](bancos/rosco.json) | Importar en el banco del Rosco (A–Z + Ñ). |
| [sql/ajustes-evento.sql](sql/ajustes-evento.sql) | SQL Editor: subir/verificar/revertir `limites_acceso` y contar bancos. **No es una migración.** |
| [planillas/control-salas.csv](planillas/control-salas.csv) | Planilla de salas, ganadores y observaciones (abre en Excel/Sheets). |
