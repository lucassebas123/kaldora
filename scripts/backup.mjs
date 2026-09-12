// scripts/backup.mjs
//
// RESPALDO LOCAL DE SUPABASE (plan Free no tiene backups ni PITR).
//
// Exporta a `backups/<fecha>/` todas las tablas con datos irremplazables,
// vía REST con la service_role key (bypassa RLS). No usa Docker: funciona
// aunque la CLI no pueda ejecutar pg_dump.
//
//   * `palabras` (600k) NO se exporta: se regenera con la migración
//     `20260109000000_diccionario.sql` (contiene las insert completas).
//   * Deja un `manifest.json` con filas y sha256 por archivo (integridad).
//   * Escribe con permisos 600 (contiene PII: nunca a Git).
//
// Uso:
//   node scripts/backup.mjs
//   SUPABASE_SERVICE_ROLE_KEY=... node scripts/backup.mjs   (sin CLI)
//
// Restaurar (p. ej. en staging): node scripts/restore.mjs --dir backups/<fecha>

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');

// --- .env -----------------------------------------------------------------
for (const linea of readFileSync(join(RAIZ, '.env'), 'utf8').split('\n')) {
  const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

// --- Proyecto y service_role ------------------------------------------------
function refDelProyecto() {
  return readFileSync(join(RAIZ, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
}

function serviceRoleDeCli(ref) {
  const salida = execFileSync(
    'npx',
    ['supabase', 'projects', 'api-keys', '--project-ref', ref, '-o', 'json'],
    { encoding: 'utf8', cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const llaves = JSON.parse(salida);
  const sr = llaves.find((k) => k.name === 'service_role');
  if (!sr?.api_key) throw new Error('No se pudo obtener la service_role key');
  return sr.api_key;
}

const REF = refDelProyecto();
const URL = process.env.VITE_SUPABASE_URL || `https://${REF}.supabase.co`;
const SERVICE =
  process.env.SUPABASE_SERVICE_ROLE_KEY || serviceRoleDeCli(REF);

if (!URL.includes(REF)) {
  throw new Error(`VITE_SUPABASE_URL (${URL}) no corresponde al proyecto linkeado ${REF}`);
}

// --- Tablas a respaldar -----------------------------------------------------
// `palabras`: regenerable por migración (600k filas) → no se exporta.
const TABLAS = [
  { nombre: 'registros_jugadores', orden: 'id' },
  { nombre: 'admins_autorizados', orden: 'creado_en' },
  { nombre: 'salas', orden: 'id' },
  { nombre: 'jugadores', orden: 'id' },
  { nombre: 'sesiones_jugador', orden: 'id_jugador' },
  { nombre: 'preguntas', orden: 'id' },
  { nombre: 'preguntas_trivia', orden: 'id' },
  { nombre: 'preguntas_supervivencia', orden: 'id' },
  { nombre: 'categorias_basta', orden: 'id' },
  { nombre: 'lexico_categorias', orden: 'id_categoria' },
  { nombre: 'rosco_respuestas', orden: 'id' },
  { nombre: 'trivia_respuestas', orden: 'id' },
  { nombre: 'respuestas_basta', orden: 'id' },
  { nombre: 'supervivencia_respuestas', orden: 'id' },
];

const PAGINA = 1000;

async function traerTabla(supabase, tabla) {
  const filas = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from(tabla.nombre)
      .select('*')
      .order(tabla.orden, { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`${tabla.nombre}: ${error.message}`);
    filas.push(...(data || []));
    if (!data || data.length < PAGINA) break;
  }
  return filas;
}

function sha256(texto) {
  return createHash('sha256').update(texto).digest('hex');
}

async function main() {
  const supabase = createClient(URL, SERVICE, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket },
  });

  const marca = new Date().toISOString().replace(/[:.]/g, '-');
  const destino = join(RAIZ, 'backups', marca);
  mkdirSync(destino, { recursive: true, mode: 0o700 });

  console.log(`Backup del proyecto ${REF}`);
  console.log(`Destino: ${destino}\n`);

  const manifiesto = {
    proyecto: REF,
    url: URL,
    fecha: new Date().toISOString(),
    tablas: {},
    nota:
      'palabras no se respalda: se regenera con supabase/migrations/20260109000000_diccionario.sql',
  };

  let total = 0;
  for (const tabla of TABLAS) {
    process.stdout.write(`  ${tabla.nombre.padEnd(28)} `);
    const filas = await traerTabla(supabase, tabla);
    const json = JSON.stringify(filas);
    writeFileSync(join(destino, `${tabla.nombre}.json`), json, { mode: 0o600 });
    manifiesto.tablas[tabla.nombre] = { filas: filas.length, sha256: sha256(json) };
    total += filas.length;
    console.log(`${String(filas.length).padStart(7)} filas`);
  }

  // Conteo de `palabras` solo como dato de control (no se exporta).
  const { count } = await supabase
    .from('palabras')
    .select('*', { count: 'exact', head: true });
  manifiesto.palabras_filas = count ?? null;
  manifiesto.total_filas_exportadas = total;

  writeFileSync(join(destino, 'manifest.json'), JSON.stringify(manifiesto, null, 2), {
    mode: 0o600,
  });

  console.log(`\nTotal exportado: ${total} filas (palabras: ${count ?? '?'}, no exportada)`);
  console.log(`Manifiesto: ${join(destino, 'manifest.json')}`);
}

main().catch((e) => {
  console.error('\nBackup FALLÓ:', e.message);
  process.exit(1);
});
