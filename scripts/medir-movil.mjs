// scripts/medir-movil.mjs
//
// MEDICIÓN MÓVIL — abre pantallas reales en Chromium con viewports de celular
// y reporta, con nombre y clase, todo elemento que ensanche la página
// (overflow horizontal = el usuario tiene que alejar el zoom) y el tamaño de
// fuente de los inputs (Safari iOS hace zoom si son < 16 px).
//
// Uso:
//   node scripts/medir-movil.mjs                       # producción
//   BASE_UI=https://kaldora.site node scripts/medir-movil.mjs
//   ENTORNO=staging node scripts/medir-movil.mjs       # contra staging
//
// Crea una sala de prueba y la borra al terminar (los registros de prueba se
// limpian con service_role si está disponible).

import { chromium } from 'playwright';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { cargarEntorno, servicioDeCli } from './_entorno.mjs';

const env = cargarEntorno();
const BASE = process.env.BASE_UI || 'https://kaldora.site';
const VIEWPORTS = [
  [320, 568, 'iPhone SE'],
  [360, 640, 'Android chico'],
  [390, 844, 'iPhone 14'],
];

const api = createClient(env.url, env.anon, {
  realtime: { transport: WebSocket },
  auth: { storageKey: `medir-${Date.now()}`, persistSession: false },
});
const login = await api.auth.signInWithPassword({ email: env.hostEmail, password: env.hostPass });
if (login.error) {
  console.error('Login del host falló:', login.error.message);
  process.exit(2);
}
const { data: tokenHost } = await api.auth.getSession();
const { data: sala, error: errSala } = await api.rpc('crear_sala');
if (errSala) {
  console.error('crear_sala:', errSala.message);
  process.exit(2);
}
// Un jugador de prueba para que el lobby del admin tenga contenido real.
const jugador = createClient(env.url, env.anon, {
  realtime: { transport: WebSocket },
  auth: { storageKey: `medir-j-${Date.now()}`, persistSession: false },
});
await jugador.rpc('unirse_sala', {
  p_codigo: sala.codigo,
  p_nickname: 'Medicion',
  p_icono: 'Star',
  p_color: 'bg-purple-500',
  p_nombre: 'Medi',
  p_apellido: 'Cion',
  p_telefono: '+54 9 11 4444-0000',
  p_correo: `medir.${Date.now().toString(36)}@example.com`,
});
console.log(`Medición en ${BASE} · sala ${sala.codigo} (${sala.id})\n`);

const browser = await chromium.launch();

async function medir(nombre, path, { sesion = null } = {}) {
  for (const [w, h, etiqueta] of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    if (sesion) {
      await ctx.addInitScript(
        ([url, session]) => {
          window.localStorage.setItem(
            `sb-${new URL(url).hostname.split('.')[0]}-auth-token`,
            JSON.stringify(session)
          );
        },
        [env.url, sesion]
      );
    }
    const page = await ctx.newPage();
    await page.goto(`${BASE}${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    // Si la ruta estaba protegida, confirmar que no quedó en el login.
    if (page.url().includes('/admin/login')) {
      console.log(`   ⚠ ${nombre} @ ${w}px: redirigió al login (no se midió el panel)`);
      await ctx.close();
      continue;
    }
    const r = await page.evaluate(() => {
      const vw = window.innerWidth;
      const malos = [];
      for (const el of document.querySelectorAll('body *')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 && b.height === 0) continue;
        if (getComputedStyle(el).position === 'fixed') continue;
        if (b.right > vw + 1 || b.left < -1) {
          malos.push({
            tag: el.tagName.toLowerCase(),
            clase: (el.className || '').toString().slice(0, 90),
            izq: Math.round(b.left),
            der: Math.round(b.right),
          });
        }
      }
      const inputs = [...document.querySelectorAll('input,textarea')]
        .filter((e) => e.offsetParent !== null && e.type !== 'hidden' && e.type !== 'file')
        .map((e) => parseFloat(getComputedStyle(e).fontSize));
      return { vw, scrollWidth: document.documentElement.scrollWidth, malos, inputs };
    });
    const overflow = r.scrollWidth > r.vw + 1;
    console.log(
      `── ${nombre} @ ${w}px (${etiqueta}): ${overflow ? `OVERFLOW scrollWidth ${r.scrollWidth} > ${r.vw}` : 'OK'}`
    );
    for (const m of r.malos.slice(0, 6)) {
      console.log(`     ${m.tag} [${m.izq}..${m.der}] · ${m.clase}`);
    }
    if (r.inputs.length) {
      const chicos = r.inputs.filter((f) => f < 16);
      console.log(
        `     inputs: ${r.inputs.join(',')}${chicos.length ? `  ← ${chicos.length} con <16px (auto-zoom iOS)` : '  ✓ todos ≥16px'}`
      );
    }
    await ctx.close();
  }
}

await medir('Landing (registro)', `/?sala=${sala.codigo}`);
await medir('Panel admin (lobby)', `/admin/sala/${sala.id}`, { sesion: tokenHost.session });

await browser.close();

// Limpieza: sala + registros de prueba si hay service_role.
await api.rpc('borrar_sala', { p_sala: sala.id });
try {
  const service = env.service || servicioDeCli();
  const admin = createClient(env.url, service, { realtime: { transport: WebSocket } });
  const { data: filas } = await admin
    .from('registros_jugadores')
    .select('id, correo')
    .ilike('correo', 'medir.%@example.com');
  if (filas?.length) {
    await admin.from('registros_jugadores').delete().in('id', filas.map((f) => f.id));
  }
} catch {
  /* sin service_role: los registros de prueba quedan (no crítico) */
}
console.log('\nLimpieza: sala borrada.');
process.exit(0);
