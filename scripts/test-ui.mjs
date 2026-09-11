// scripts/test-ui.mjs
//
// TEST DE INTERFAZ (navegador real con Playwright):
//   1. Landing: PIN + nickname + registro → entrar sin errores
//   2. Sala de espera visible
//   3. Anfitrión: login + crear sala + lanzar CADA juego → los paneles
//      renderizan (aquí se detecta el "pantalla en blanco")
//   4. Jugador muta al juego lanzado (rosco, trivia, basta, supervivencia)
//   5. Cero errores de consola tipo ReferenceError/blank screen
//
// Uso: node scripts/test-ui.mjs

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

for (const l of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = l.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const SUPA_URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const BASE = 'http://localhost:5173';

let pasadas = 0;
let falladas = 0;
function verificar(desc, ok) {
  ok ? pasadas++ : falladas++;
  console.log(`  ${ok ? '✓' : '✗ FALLO:'} ${desc}`);
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- backend: crear sala con el host real (para alimentar la UI) -------------
const api = createClient(SUPA_URL, ANON, { realtime: { transport: WebSocket } });
await api.auth.signInWithPassword({
  email: 'admin31@admin.com',
  password: '2AdmIN2026',
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
await pagJugador.locator('input[placeholder="Correo"]').fill('nora@example.com');
await pagJugador.getByRole('button', { name: /Entrar a la sala/i }).click();
const llegoJugador = await pagJugador.waitForURL('**/jugar/**', { timeout: 15000 }).then(() => true).catch(() => false);
verificar('registro completo → entra a la sala (/jugar/...)', llegoJugador);
const esperaVisible = await pagJugador.getByText('¡Estás dentro, PlaywrightPro!').waitFor({ timeout: 15000 }).then(() => true).catch(() => false);
verificar('sala de espera visible con el nickname', esperaVisible);
if (!esperaVisible) console.log('    [debug jugador]', (await pagJugador.locator('body').innerText()).slice(0, 300).replace(/\n/g, ' | '));

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
  { id: 'trivia', tarjeta: /Trivia de Velocidad/, marcadorHost: /Siguiente pregunta/, marcadorJugador: /Cargando pregunta|CORRECTO|Uhh, no era|Se derritió/ },
  { id: 'basta', tarjeta: /Basta!/, marcadorHost: /Cerrar ronda/, marcadorJugador: /¡BASTA!|Completá las 5 categorías/ },
  { id: 'supervivencia', tarjeta: /Supervivencia/, marcadorHost: /Siguiente ronda/, marcadorJugador: /VERDADERO|VIVO|ELIMINADO/ },
];

for (const juego of juegos) {
  // Reiniciar al lobby antes de cada juego.
  const lobby = pagHost.getByRole('button', { name: 'Lobby', exact: true });
  if ((await lobby.count()) && (await lobby.isEnabled())) {
    await lobby.click();
    await pagHost.getByText('Elegí el juego').first().waitFor({ timeout: 15000 }).catch(() => {});
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
