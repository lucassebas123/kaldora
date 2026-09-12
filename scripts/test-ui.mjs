// scripts/test-ui.mjs
//
// TEST DE INTERFAZ (navegador real con Playwright):
//   1. Landing: PIN + nickname + registro → entrar sin errores
//   2. Sala de espera visible
//   3. Anfitrión: login + crear sala + lanzar CADA juego → los paneles
//      renderizan (aquí se detecta el "pantalla en blanco")
//   4. Jugador muta al juego lanzado (rosco, trivia, basta, supervivencia)
//   5. Invitación: #type=invite redirige a /admin/invitacion y un token
//      inválido muestra "link vencido" sin crash
//   6. Cero errores de consola tipo ReferenceError/blank screen
//
// Uso: node scripts/test-ui.mjs

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { cargarEntorno } from './_entorno.mjs';

// Entorno: `.env` (producción) o `.env.staging` con ENTORNO=staging.
const env = cargarEntorno();
const SUPA_URL = env.url;
const ANON = env.anon;
const BASE = 'http://localhost:5173';

let pasadas = 0;
let falladas = 0;
function verificar(desc, ok) {
  if (ok) pasadas++;
  else falladas++;
  console.log(`  ${ok ? '✓' : '✗ FALLO:'} ${desc}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- backend: crear sala con el host real (para alimentar la UI) -------------
const api = createClient(SUPA_URL, ANON, { realtime: { transport: WebSocket } });
await api.auth.signInWithPassword({
  email: env.hostEmail,
  password: env.hostPass,
});
const { data: tokenHost } = await api.auth.getSession();
const sala = (await api.rpc('crear_sala')).data;
console.log(`\nSala de prueba: ${sala.codigo}`);

// --- navegador ----------------------------------------------------------------
const browser = await chromium.launch();
const erroresJS = [];

// Contexto del ANFITRIÓN (sesión de Supabase inyectada en localStorage)
const ctxHost = await browser.newContext({ viewport: { width: 1400, height: 900 } });
await ctxHost.addInitScript(
  ([url, session]) => {
    window.localStorage.setItem(
      `sb-${new URL(url).hostname.split('.')[0]}-auth-token`,
      JSON.stringify(session)
    );
  },
  [SUPA_URL, tokenHost.session]
);
const pagHost = await ctxHost.newPage();
pagHost.on('pageerror', (e) => erroresJS.push(`HOST: ${e.message}`));
// Los controles peligrosos (Lobby) piden confirmación: aceptarla en el test.
pagHost.on('dialog', (dialog) => dialog.accept());

// Contexto del JUGADOR
const ctxJugador = await browser.newContext({ viewport: { width: 390, height: 844 } });
const pagJugador = await ctxJugador.newPage();
pagJugador.on('pageerror', (e) => erroresJS.push(`JUGADOR: ${e.message}`));

// -----------------------------------------------------------------------------
console.log('\n═══ 1. Landing + registro del jugador ═══');
await pagJugador.goto(`${BASE}/?sala=${sala.codigo}`, { waitUntil: 'domcontentloaded' });
const pinVisible = await pagJugador.locator('input[aria-label="PIN de la sala"]').inputValue();
verificar('landing precarga el PIN desde la URL', pinVisible === sala.codigo);

await pagJugador.locator('input[placeholder^="Ej:"]').fill('PlaywrightPro');
await pagJugador.locator('input[placeholder="Nombre"]').fill('Nora');
await pagJugador.locator('input[placeholder="Apellido"]').fill('De Pruebas');
await pagJugador.locator('input[placeholder="Celular"]').fill('1155550099');
await pagJugador.locator('input[placeholder="Correo"]').fill(`nora.${Date.now()}@example.com`);

// Toggle: modo login oculta el registro y muestra el identificador único.
await pagJugador.getByRole('button', { name: 'Ingresa aquí' }).click();
const sinRegistro = (await pagJugador.locator('input[placeholder="Nombre"]').count()) === 0;
const conIdentificador = (await pagJugador.locator('input[placeholder="Correo, celular o PIN de Jugador"]').count()) === 1;
verificar('modo login oculta los datos personales', sinRegistro);
verificar('modo login muestra el identificador de jugador', conIdentificador);
await pagJugador.getByRole('button', { name: 'Regístrate aquí' }).click();

await pagJugador.getByRole('button', { name: /Entrar a la sala/i }).click();

// Modal con el PIN de jugador recién generado + copiar.
const pinJugadorVisible = await pagJugador
  .getByText(/JUG-[0-9]{6}/)
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verificar('registro exitoso → modal con PIN de jugador', pinJugadorVisible);
if (pinJugadorVisible) await pagJugador.getByRole('button', { name: /Copiar PIN de jugador/i }).click();
await pagJugador.getByRole('button', { name: /Continuar a la sala/i }).click();

const llegoJugador = await pagJugador.waitForURL('**/jugar/**', { timeout: 15000 }).then(() => true).catch(() => false);
verificar('registro completo → entra a la sala (/jugar/...)', llegoJugador);
const esperaVisible = await pagJugador.getByText('¡Estás dentro, PlaywrightPro!').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
verificar('sala de espera visible con el nickname', esperaVisible);
if (!esperaVisible) console.log('    [debug jugador]', (await pagJugador.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));

// -----------------------------------------------------------------------------
console.log('\n═══ 1b. Aviso de conexión (regresión: silencio ≠ caída) ═══');
// El aviso salía por falso positivo cuando el canal quedaba 12 s "mudo":
// desde que el reloj va por REST y los canales filtran por sala, no recibir
// eventos es lo normal. Debe aparecer SOLO con una falla real.
const avisoBanner = pagJugador.getByText(/Reconectando|Conexión inestable/i);
await esperar(20000);
const falsoPositivo = await avisoBanner.count();
verificar('20 s sin actividad: NO aparece el aviso (silencio no es caída)', falsoPositivo === 0);
if (falsoPositivo) {
  console.log('    [debug aviso]', (await pagJugador.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | '));
}

// Caída real del dispositivo: debe reaccionar (banner o pantalla de conexión).
await ctxJugador.setOffline(true);
const reaccionaCaida = await pagJugador
  .getByText(/Reconectando|Conexión inestable|Perdimos la conexión/i)
  .first()
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verificar('sin red: el cliente avisa al usuario', reaccionaCaida);

await ctxJugador.setOffline(false);
const seRecupera = await pagJugador
  .getByText('¡Estás dentro, PlaywrightPro!')
  .waitFor({ timeout: 20000 })
  .then(() => true)
  .catch(() => false);
verificar('al volver la red: se recupera solo (sala de espera visible)', seRecupera);
await esperar(1000);
verificar('al volver la red: el aviso desaparece', (await avisoBanner.count()) === 0);

// -----------------------------------------------------------------------------
console.log('\n═══ 2. Panel admin: la sala carga ═══');
await pagHost.goto(`${BASE}/admin/sala/${sala.id}`, { waitUntil: 'domcontentloaded' });
const pinEnPanel = await pagHost.getByText(sala.codigo).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
verificar('panel admin muestra el PIN', pinEnPanel);
const jugadorEnLobby = await pagHost.getByText('PlaywrightPro').first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
verificar('jugador visible en el lobby del admin', jugadorEnLobby);
verificar('botón Banco de preguntas presente', (await pagHost.getByText('Banco de preguntas').count()) > 0);
if (!pinEnPanel) console.log('    [debug admin]', (await pagHost.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));

// -----------------------------------------------------------------------------
console.log('\n═══ 3. Lanzar LOS 4 JUEGOS (aquí vivía la pantalla en blanco) ═══');
const juegos = [
  { id: 'rosco', tarjeta: /El Rosco/, marcadorHost: /Rosco en curso/, marcadorJugador: /Pasar|Pasapalabra|Tu rosco|palabra/i },
  { id: 'trivia', tarjeta: /Trivia de Velocidad/, marcadorHost: /Siguiente pregunta/, marcadorJugador: /Cargando pregunta|CORRECTO|Uhh, no era|Se derritió|Ronda/ },
  { id: 'basta', tarjeta: /Basta!/, marcadorHost: /Cerrar ronda/, marcadorJugador: /¡BASTA!|Completá las 5 categorías/ },
  { id: 'supervivencia', tarjeta: /Supervivencia/, marcadorHost: /Siguiente ronda/, marcadorJugador: /VERDADERO|VIVO|ELIMINADO/ },
];

for (const juego of juegos) {
  // Reiniciar al lobby antes de cada juego. Reintenta: el botón queda
  // deshabilitado mientras la RPC anterior sigue en vuelo (timing real).
  const lobby = pagHost.getByRole('button', { name: 'Lobby', exact: true });
  let enLobby = false;
  for (let intento = 0; intento < 12 && !enLobby; intento++) {
    if ((await lobby.count()) && (await lobby.isEnabled())) {
      await lobby.click();
    }
    enLobby = await pagHost
      .getByText('Elegí el juego')
      .first()
      .waitFor({ timeout: 3000 })
      .then(() => true)
      .catch(() => false);
    if (!enLobby) await esperar(1000);
  }
  if (!enLobby) {
    console.log('    [debug lobby]', (await pagHost.locator('body').innerText()).slice(0, 200).replace(/\n/g, ' | '));
  }

  await pagHost.getByText(juego.tarjeta).first().click();
  await pagHost.getByRole('button', { name: /¡Lanzar!/i }).click();

  const hostOk = await pagHost.locator('body').getByText(juego.marcadorHost).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  verificar(`[${juego.id}] panel del anfitrión renderiza (${juego.marcadorHost})`, hostOk);
  const textoHost = (await pagHost.locator('body').innerText()).trim();
  verificar(`[${juego.id}] admin sin pantalla en blanco`, textoHost.length > 100);

  const jugadorOk = await pagJugador.locator('body').getByText(juego.marcadorJugador).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
  verificar(`[${juego.id}] el celular del jugador muta al juego`, jugadorOk);
  if (!jugadorOk || !hostOk) {
    console.log('    [debug host]', textoHost.slice(0, 250).replace(/\n/g, ' | '));
    console.log('    [debug jugador]', (await pagJugador.locator('body').innerText()).slice(0, 250).replace(/\n/g, ' | '));
  }
}

// -----------------------------------------------------------------------------
console.log('\n═══ 4. Podio final ═══');
await pagHost.getByRole('button', { name: 'Terminar' }).click();
const podio = await pagJugador.locator('body').getByText(/Podio final|Partida finalizada|GANASTE/).first().waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
verificar('podio en el celular del jugador', podio);

// El confeti del podio (canvas-confetti) crea un canvas fixed con
// pointer-events:none. Fase 0: verificar que realmente se dispara.
const confeti = await pagJugador
  .waitForFunction(
    () => [...document.querySelectorAll('canvas')].some((c) => c.style.position === 'fixed' && c.style.pointerEvents === 'none'),
    null,
    { timeout: 6000 }
  )
  .then(() => true)
  .catch(() => false);
verificar('confeti del podio: canvas activo tras terminar', confeti);
if (!confeti) {
  console.log('    [debug confeti] canvas en el DOM:', await pagJugador.evaluate(() => document.querySelectorAll('canvas').length));
}

// -----------------------------------------------------------------------------
console.log('\n═══ 4b. Aceptar invitación ═══');
const ctxInvitado = await browser.newContext({ viewport: { width: 390, height: 844 } });
const pagInvitado = await ctxInvitado.newPage();
pagInvitado.on('pageerror', (e) => erroresJS.push(`INVITADO: ${e.message}`));

// 1) El mail aterriza en la Site URL (raíz) con #type=invite: la app debe
//    redirigir sola a /admin/invitacion (acá con un token inválido → error).
await pagInvitado.goto(`${BASE}/#access_token=token-falso&refresh_token=x&type=invite`, {
  waitUntil: 'domcontentloaded',
});
const redirigido = await pagInvitado
  .waitForURL('**/admin/invitacion', { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verificar('link de invitación (#type=invite) redirige a /admin/invitacion', redirigido);
const linkVencido = await pagInvitado
  .getByText(/ya venció|link inválido|No encontramos una invitación/i)
  .first()
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verificar('invitación con token inválido → link vencido (sin crash)', linkVencido);
if (!linkVencido) console.log('    [debug invitación]', (await pagInvitado.locator('body').innerText()).slice(0, 250).replace(/\n/g, ' | '));

// 2) Entrada directa sin token.
await pagInvitado.goto(`${BASE}/admin/invitacion`, { waitUntil: 'domcontentloaded' });
const directoVencido = await pagInvitado
  .getByText(/ya venció|link inválido|No encontramos una invitación/i)
  .first()
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
verificar('/admin/invitacion sin token → link vencido (sin crash)', directoVencido);
await ctxInvitado.close();

// -----------------------------------------------------------------------------
console.log('\n═══ 5. Errores de JavaScript ═══');
const erroresGraves = erroresJS.filter(
  (e) => !/favicon|Autoplay|play\(\)|interact with the AudioContext/i.test(e)
);
verificar('sin errores JS (pantallas en blanco = crash JS)', erroresGraves.length === 0);
if (erroresGraves.length) console.log(erroresGraves.slice(0, 6).join('\n'));

// Limpieza
await api.rpc('borrar_sala', { p_sala: sala.id });
await browser.close();

console.log(`\nRESULTADO UI: ${pasadas} OK · ${falladas} fallos`);
process.exit(falladas > 0 ? 1 : 0);
