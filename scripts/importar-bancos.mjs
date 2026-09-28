// scripts/importar-bancos.mjs
//
// Publica los bancos de docs/bancos/*.json en `bancos_semilla` y los importa
// a las tablas reales. Es IDEMPOTENTE: la importación corre en el servidor
// (`importar_banco_semilla`) y solo inserta lo que falta según la pregunta
// normalizada, así correrlo dos veces no duplica filas.
//
// Uso:
//   node scripts/importar-bancos.mjs                      # producción (.env)
//   node scripts/importar-bancos.mjs --dry                # solo reporte
//   ENTORNO=staging node scripts/importar-bancos.mjs      # proyecto espejo
//   node scripts/importar-bancos.mjs --solo=trivia,rosco  # bancos puntuales
//
// Requiere credenciales de anfitrión: HOST_EMAIL / HOST_PASS en el .env del
// entorno (el helper _entorno.mjs tiene los mismos defaults que el resto de
// los scripts). También requiere la migración `bancos_semilla` aplicada.
// Las claves nunca se imprimen.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cargarEntorno, cliente, RAIZ } from './_entorno.mjs';

const BANCOS = ['trivia', 'supervivencia', 'rosco'];
const PAGINA = 1000; // tope de PostgREST por select.

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const soloArg = args.find((a) => a.startsWith('--solo='));
const seleccion = soloArg
  ? soloArg.slice('--solo='.length).split(',').map((s) => s.trim()).filter(Boolean)
  : [...BANCOS];
const invalidos = seleccion.filter((b) => !BANCOS.includes(b));
if (invalidos.length) {
  console.error(`✗ Banco(s) desconocido(s): ${invalidos.join(', ')} (válidos: ${BANCOS.join(', ')})`);
  process.exit(2);
}

function tablaDe(banco) {
  return banco === 'rosco' ? 'preguntas' : `preguntas_${banco}`;
}

/** Clave de comparación: minúsculas, sin tildes, espacios colapsados. */
function normalizar(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function leerArchivo(banco) {
  const ruta = join(RAIZ, 'docs', 'bancos', `${banco}.json`);
  let crudo;
  try {
    crudo = readFileSync(ruta, 'utf8');
  } catch {
    throw new Error(`No se pudo leer ${ruta}`);
  }
  const items = JSON.parse(crudo);
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error(`${ruta} no contiene un array con ítems`);
  }
  return items;
}

async function traerPreguntasExistentes(tabla) {
  const claves = new Set();
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await supabase
      .from(tabla)
      .select('pregunta')
      .order('id')
      .range(desde, desde + PAGINA - 1);
    if (error) throw new Error(`No se pudo leer ${tabla}: ${error.message}`);
    for (const fila of data || []) claves.add(normalizar(fila.pregunta));
    if (!data || data.length < PAGINA) break;
  }
  return claves;
}

async function contarFilas(tabla) {
  const { count, error } = await supabase
    .from(tabla)
    .select('id', { count: 'exact', head: true });
  if (error) throw new Error(`No se pudo contar ${tabla}: ${error.message}`);
  return count ?? 0;
}

/** Reporte sin escrituras: cuántos ítems del archivo ya existen. */
async function previsualizar(banco) {
  const tabla = tablaDe(banco);
  const items = leerArchivo(banco);
  const existentes = await traerPreguntasExistentes(tabla);

  let omitidos = 0;
  const vistos = new Set();
  for (const item of items) {
    const clave = normalizar(item.pregunta);
    if (existentes.has(clave) || vistos.has(clave)) {
      omitidos += 1;
      continue;
    }
    vistos.add(clave);
  }
  const total = await contarFilas(tabla);
  console.log(`\n── ${banco} ─────────────────────────────────────────────`);
  console.log(`   en archivo: ${items.length} | ya existentes: ${omitidos} | nuevos: ${items.length - omitidos}`);
  console.log(`   insertados: 0 (--dry) | total en la base: ${total}`);
  return { banco, enArchivo: items.length, omitidos, insertados: 0, total };
}

/** Publica el banco en `bancos_semilla` y lo importa (todo en el servidor). */
async function importar(banco) {
  const items = leerArchivo(banco);

  const { data: publicados, error: errPublicar } = await supabase.rpc('publicar_banco_semilla', {
    p_banco: banco,
    p_items: items,
  });
  if (errPublicar) throw new Error(`publicar_banco_semilla(${banco}) falló: ${errPublicar.message}`);

  const { data: res, error: errImportar } = await supabase.rpc('importar_banco_semilla', {
    p_banco: banco,
  });
  if (errImportar) throw new Error(`importar_banco_semilla(${banco}) falló: ${errImportar.message}`);

  const insertados = res?.insertados ?? 0;
  const omitidos = res?.omitidos ?? 0;
  const total = res?.total ?? (await contarFilas(tablaDe(banco)));

  console.log(`\n── ${banco} ─────────────────────────────────────────────`);
  console.log(`   en archivo: ${items.length} | publicados: ${publicados} | insertados: ${insertados} | omitidos: ${omitidos}`);
  console.log(`   total en la base: ${total}`);
  return { banco, enArchivo: items.length, publicados, insertados, omitidos, total };
}

const env = cargarEntorno();
console.log('══════════════════════════════════════════════════════════════');
console.log(`  KALDORA — IMPORTAR BANCOS  (entorno: ${env.archivo}${dry ? ' · modo: --dry' : ''})`);
console.log(`  Bancos: ${seleccion.join(', ')}`);
console.log('══════════════════════════════════════════════════════════════');

const supabase = cliente(env.url, env.anon, 'importar-bancos');
const { error: loginError } = await supabase.auth.signInWithPassword({
  email: env.hostEmail,
  password: env.hostPass,
});
if (loginError) {
  console.error(`✗ Login de anfitrión falló: ${loginError.message}`);
  process.exit(2);
}

const resumen = [];
let fallo = null;
for (const banco of seleccion) {
  try {
    resumen.push(dry ? await previsualizar(banco) : await importar(banco));
  } catch (e) {
    fallo = e;
    console.error(`✗ ${banco}: ${e.message}`);
    break;
  }
}

console.log('\n══════════════════════════════════════════════════════════════');
for (const r of resumen) {
  console.log(
    `  ${r.banco.padEnd(14)} archivo ${String(r.enArchivo).padStart(4)} | omitidos ${String(r.omitidos).padStart(4)} | insertados ${String(r.insertados).padStart(4)} | total ${String(r.total).padStart(4)}`
  );
}
console.log(fallo ? `  ✗ Terminó con error: ${fallo.message}` : '  ✔ Importación OK');
await supabase.auth.signOut();
process.exit(fallo ? 1 : 0);
