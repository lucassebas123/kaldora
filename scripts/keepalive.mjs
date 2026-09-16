// scripts/keepalive.mjs
//
// KEEP-ALIVE ANTI-PAUSA (plan Free de Supabase)
// ============================================
// Supabase pausa los proyectos Free con baja actividad durante 7 días. Esto
// los despertaría en pleno evento con downtime. Una mínima actividad diaria
// de base alcanza para no ser pausado (según la documentación de Supabase).
//
// Hace dos lecturas REST livianas con la anon key (sin datos sensibles).
//
// Uso local:      node scripts/keepalive.mjs
// En GitHub Actions (3 veces al día): secrets VITE_SUPABASE_URL y
// VITE_SUPABASE_ANON_KEY.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

// En CI no hay .env: las credenciales llegan por variables de entorno.
try {
  for (const linea of readFileSync(join(RAIZ, '.env'), 'utf8').split('\n')) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {
  /* sin .env: se usan las variables del entorno (GitHub Actions) */
}

const URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;

if (!URL || !ANON) {
  console.error('Faltan VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY');
  process.exit(2);
}

const cabeceras = { apikey: ANON, Authorization: `Bearer ${ANON}` };

const consultas = [
  `${URL}/rest/v1/salas?select=id&limit=1`,
  `${URL}/rest/v1/categorias_basta?select=id&limit=1`,
];

let ok = true;
for (const consulta of consultas) {
  try {
    const res = await fetch(consulta, {
      headers: cabeceras,
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`  ✓ ${res.status} ${consulta.replace(URL, '')}`);
  } catch (e) {
    ok = false;
    console.error(`  ✗ ${consulta.replace(URL, '')}: ${e.message}`);
  }
}

console.log(ok ? 'Keep-alive OK: el proyecto queda activo por hoy.' : 'Keep-alive FALLÓ.');
process.exit(ok ? 0 : 1);
