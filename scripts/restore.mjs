// scripts/restore.mjs
//
// RESTAURA un respaldo de `scripts/backup.mjs` sobre un proyecto destino
// (staging para el drill, o un proyecto nuevo tras un desastre).
//
//   * Restaura SOLO los datos irremplazables (no las tablas transitorias de
//     partida): bancos de preguntas, categorías/léxicos, registros de
//     jugadores y admins autorizados.
//   * `registros_jugadores.id_jugador` se restaura en NULL: las filas de
//     `jugadores` son transitorias y en el destino pueden no existir.
//   * Verifica el sha256 de cada archivo contra el manifest antes de importar.
//
// Uso:
//   node scripts/restore.mjs --dir backups/<fecha>
//   (lee STAGING_SUPABASE_URL y STAGING_SERVICE_ROLE_KEY de .env.staging)
//
//   node scripts/restore.mjs --dir backups/<fecha> \
//     --url https://<ref>.supabase.co --key <service_role>   (destino manual)

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');

// --- argumentos --------------------------------------------------------------
function arg(nombre) {
  const i = process.argv.indexOf(`--${nombre}`);
  return i >= 0 ? process.argv[i + 1] : null;
}

const DIR = arg('dir');
if (!DIR) {
  console.error('Falta --dir backups/<fecha>');
  process.exit(1);
}

// --- entorno ----------------------------------------------------------------
let ENV = {};
try {
  ENV = Object.fromEntries(
    readFileSync(join(RAIZ, '.env.staging'), 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z_]/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
} catch {
  /* sin .env.staging */
}

const URL = arg('url') || ENV.STAGING_SUPABASE_URL;
const SERVICE = arg('key') || ENV.STAGING_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!URL || !SERVICE) {
  console.error('Falta destino: --url/--key o STAGING_SUPABASE_URL/STAGING_SERVICE_ROLE_KEY en .env.staging');
  process.exit(1);
}

// Orden FK-safe: primero los padres.
const TABLAS = [
  'categorias_basta',
  'lexico_categorias',
  'preguntas',
  'preguntas_trivia',
  'preguntas_supervivencia',
  'registros_jugadores',
];

const sha256 = (texto) => createHash('sha256').update(texto).digest('hex');
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function insertar(supabase, tabla, filas) {
  const LOTE = 500;
  for (let i = 0; i < filas.length; i += LOTE) {
    let intento = 0;
    for (;;) {
      const { error } = await supabase.from(tabla).insert(filas.slice(i, i + LOTE));
      if (!error) break;
      intento += 1;
      if (intento >= 3) throw new Error(`${tabla} [${i}]: ${error.message}`);
      await esperar(500 * intento);
    }
  }
}

async function main() {
  const carpeta = join(RAIZ, DIR);
  const manifest = JSON.parse(readFileSync(join(carpeta, 'manifest.json'), 'utf8'));
  const supabase = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });

  console.log(`Restaurando ${manifest.proyecto} → ${URL}`);
  console.log(`Origen: ${carpeta}\n`);

  // 0. Integridad: todo archivo debe coincidir con su sha256.
  for (const [tabla, meta] of Object.entries(manifest.tablas)) {
    const ruta = join(carpeta, `${tabla}.json`);
    const contenido = readFileSync(ruta, 'utf8');
    if (sha256(contenido) !== meta.sha256) {
      throw new Error(`Integridad rota en ${tabla}.json (sha256 no coincide)`);
    }
  }
  console.log('  ✓ integridad sha256 verificada (todos los archivos)\n');

  // 1. Limpieza de las tablas durables (orden inverso por FKs).
  for (const tabla of [...TABLAS].reverse()) {
    const { error } = await supabase.from(tabla).delete().not('id', 'is', null);
    if (error && !/0 rows/.test(error.message)) throw new Error(`limpiando ${tabla}: ${error.message}`);
  }

  // 2. Importación.
  let total = 0;
  for (const tabla of TABLAS) {
    const meta = manifest.tablas[tabla];
    if (!meta) continue;
    let filas = JSON.parse(readFileSync(join(carpeta, `${tabla}.json`), 'utf8'));
    if (tabla === 'registros_jugadores') {
      filas = filas.map((f) => ({ ...f, id_jugador: null }));
    }
    await insertar(supabase, tabla, filas);
    total += filas.length;
    console.log(`  ${tabla.padEnd(28)} ${String(filas.length).padStart(6)} filas restauradas`);
  }

  // 3. Verificación de conteo real.
  console.log('');
  let ok = true;
  for (const tabla of TABLAS) {
    const { count, error } = await supabase
      .from(tabla)
      .select('*', { count: 'exact', head: true });
    const esperado = manifest.tablas[tabla]?.filas ?? 0;
    const bien = !error && count === esperado;
    if (!bien) ok = false;
    console.log(`  ${bien ? '✓' : '✗'} ${tabla}: ${count} en destino (esperado ${esperado})`);
  }

  console.log(`\nTotal restaurado: ${total} filas`);
  console.log(ok ? 'RESTAURACIÓN VERIFICADA ✔' : 'RESTAURACIÓN CON DIFERENCIAS ✗');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('\nRestauración FALLÓ:', e.message);
  process.exit(1);
});
