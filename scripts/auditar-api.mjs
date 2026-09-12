// scripts/auditar-api.mjs
//
// AUDITORÍA ESTÁTICA DE LA API — contraste frontend ↔ SQL sin tocar la base.
//
//   * Reconstruye el estado FINAL de las funciones a partir de las migraciones
//     (create / create or replace / drop en orden cronológico).
//   * Compara cada RPC que llama el frontend (`rpc('...')` en `src/`) contra
//     las funciones finales: existencia, nombres de parámetros y grants.
//   * Reporta funciones SQL que nadie usa (candidatas a código muerto).
//   * Reporta lecturas de tablas por columna contra los grants finales.
//
// Uso: node scripts/auditar-api.mjs   (no necesita red ni credenciales)

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRACIONES = join(RAIZ, 'supabase', 'migrations');
const SRC = join(RAIZ, 'src');

let errores = 0;
let avisos = 0;
const err = (m) => {
  errores++;
  console.error(`  ✗ ${m}`);
};
const warn = (m) => {
  avisos++;
  console.warn(`  ⚠ ${m}`);
};

// ---------------------------------------------------------------------------
// 1. Parsear migraciones (en orden) y reconstruir el estado final
// ---------------------------------------------------------------------------
const archivos = readdirSync(MIGRACIONES)
  .filter((f) => f.endsWith('.sql'))
  .sort();

// clave = "nombre(tipos)" · valor = { nombre, args:[nombres], tipos, grants:{}, linea, archivo }
const funciones = new Map();
// clave por nombre (puede haber overloads)
const porNombre = new Map();

// Tipos conocidos en este esquema (para distinguir "tipo" de "nombre tipo").
const TIPOS = new Set([
  'uuid', 'text', 'int', 'integer', 'boolean', 'bool', 'jsonb', 'json', 'bigint',
  'interval', 'timestamptz', 'timestamp', 'numeric', 'serial', 'smallint', 'real',
  'double', 'varchar', 'char', 'date', 'time',
]);

// Clave de firma por TIPOS (no por nombres): `drop`/`grant` usan solo tipos.
const tipoDeArg = (a) => {
  const limpio = a.trim().replace(/\s+default\s+.*$/i, '').replace(/\s+/g, ' ');
  const partes = limpio.split(' ');
  if (partes.length > 1 && !TIPOS.has(partes[0].toLowerCase())) {
    return partes.slice(1).join(' ');
  }
  return limpio;
};

const normTipos = (t) =>
  t
    .split(',')
    .map(tipoDeArg)
    .filter(Boolean)
    .join(', ')
    .toLowerCase();

const normNombres = (t) =>
  t
    .split(',')
    .map((a) => a.trim().split(/\s+/)[0])
    .filter(Boolean);

const eventosGrant = []; // { clave, anon, authenticated, public, esGrant, linea }

function registrar(nombre, argsRaw, archivo, linea, esReplace) {
  const tipos = normTipos(argsRaw);
  const clave = `${nombre}(${tipos})`;
  const previa = funciones.get(clave);
  const entrada = {
    nombre,
    clave,
    args: normNombres(argsRaw),
    tipos,
    // `create or replace` CONSERVA los ACL existentes; `create` nuevo arranca
    // con el EXECUTE por defecto a PUBLIC.
    grants: esReplace && previa ? { ...previa.grants } : { public: true, anon: null, authenticated: null },
    archivo,
    linea,
  };
  funciones.set(clave, entrada);
  if (!porNombre.has(nombre)) porNombre.set(nombre, new Set());
  porNombre.get(nombre).add(clave);
  return entrada;
}

function aplicarGrant(nombre, argsRaw, linea, texto) {
  eventosGrant.push({
    clave: `${nombre}(${normTipos(argsRaw)})`,
    destino: /\b(to|from)\s+([^;]+);?\s*$/i.exec(texto)?.[2] || '',
    esGrant: /^\s*grant/i.test(texto),
    linea,
  });
}

for (const archivo of archivos) {
  const texto = readFileSync(join(MIGRACIONES, archivo), 'utf8');
  const lineas = texto.split('\n');
  lineas.forEach((linea, i) => {
    const nro = i + 1;

    let m = linea.match(/^\s*drop function (?:if exists )?public\.([a-z_]+)\s*\(([^)]*)\)/i);
    if (m) {
      const clave = `${m[1]}(${normTipos(m[2])})`;
      funciones.delete(clave);
      return;
    }

    m = linea.match(/^\s*create (?:or replace )?function public\.([a-z_]+)\s*\(/i);
    if (m) {
      // Juntar el bloque de argumentos hasta el paréntesis de cierre.
      let bloque = linea.slice(linea.indexOf('(') + 1);
      let j = i;
      let balance = (linea.match(/\(/g) || []).length - (linea.match(/\)/g) || []).length;
      while (balance > 0 && j + 1 < lineas.length) {
        j++;
        bloque += `\n${lineas[j]}`;
        balance += (lineas[j].match(/\(/g) || []).length - (lineas[j].match(/\)/g) || []).length;
      }
      const argsRaw = bloque.slice(0, bloque.lastIndexOf(')'));
      const entrada = registrar(m[1], argsRaw, archivo, nro, /or replace/i.test(m[0]));
      // Las funciones de trigger no las expone PostgREST (se saltan en LIVE).
      entrada.esTrigger = /returns\s+trigger/i.test(lineas.slice(i, j + 2).join('\n'));
      return;
    }

    if (/^\s*(grant|revoke)\b/i.test(linea)) {
      // Los grants pueden continuar en la línea siguiente (…)\n  to anon, …;
      let completa = linea;
      let j = i;
      while (!/;\s*$/.test(completa) && j + 1 < lineas.length) {
        j++;
        completa += ` ${lineas[j]}`;
      }
      const g = completa.match(
        /^\s*(grant|revoke)[^;]*?on function public\.([a-z_]+)\s*\(([^)]*)\)(.*)$/i
      );
      if (g) aplicarGrant(g[2], g[3], nro, `${g[1]} ${g[4]}`);
    }
  });
}

// Aplicar los grants SOLO a las firmas que quedaron vigentes (los históricos
// se ignoran: son grants de funciones que ya fueron reemplazadas).
for (const ev of eventosGrant) {
  const f = funciones.get(ev.clave);
  if (!f) continue;
  for (const rol of ['public', 'anon', 'authenticated']) {
    if (new RegExp(`\\b${rol}\\b`, 'i').test(ev.destino)) f.grants[rol] = ev.esGrant;
  }
}
const acceso = (f, rol) => f.grants[rol] === true || f.grants.public === true;

if (process.env.DEBUG_FN) {
  for (const f of funciones.values()) {
    if (f.nombre.includes(process.env.DEBUG_FN)) {
      console.log(`[debug] ${f.clave} grants=${JSON.stringify(f.grants)} (${f.archivo}:${f.linea})`);
    }
  }
  for (const ev of eventosGrant) {
    if (ev.clave.includes(process.env.DEBUG_FN)) console.log(`[debug] evento ${ev.esGrant ? 'GRANT' : 'REVOKE'} ${ev.clave} → ${ev.destino}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Recolectar los RPC que llama el frontend
// ---------------------------------------------------------------------------
function archivosDe(dir) {
  const salida = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const ruta = join(dir, entrada.name);
    if (entrada.isDirectory()) salida.push(...archivosDe(ruta));
    else if (/\.(jsx?|mjs)$/.test(entrada.name)) salida.push(ruta);
  }
  return salida;
}

const llamadas = []; // { rpc, archivo, linea, claves:[...] }
for (const ruta of archivosDe(SRC)) {
  const texto = readFileSync(ruta, 'utf8');
  const regex = /\brpc\(\s*'([a-z_]+)'\s*(?:,\s*(\{[\s\S]*?\}))?\s*\)/g;
  let m;
  while ((m = regex.exec(texto))) {
    const claves = [];
    if (m[2]) {
      const claveRe = /(p_[a-z_]+)\s*:/g;
      let k;
      while ((k = claveRe.exec(m[2]))) claves.push(k[1]);
    }
    llamadas.push({
      rpc: m[1],
      archivo: ruta.replace(RAIZ + '/', ''),
      linea: texto.slice(0, m.index).split('\n').length,
      claves,
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Contraste
// ---------------------------------------------------------------------------
console.log('══════════════════════════════════════════════════════════════');
console.log('  AUDITORÍA ESTÁTICA DE LA API — frontend ↔ migraciones');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  Migraciones: ${archivos.length} · funciones finales: ${funciones.size}`);
console.log(`  RPC invocados desde src/: ${[...new Set(llamadas.map((l) => l.rpc))].length}\n`);

console.log('── RPC del frontend ─────────────────────────────────────────');
const vistos = new Set();
for (const l of llamadas) {
  const clavesFinales = porNombre.get(l.rpc);
  if (!clavesFinales || clavesFinales.size === 0) {
    err(`${l.rpc}() NO EXISTE en las migraciones (${l.archivo}:${l.linea})`);
    continue;
  }
  if (vistos.has(l.rpc)) continue;
  vistos.add(l.rpc);

  // Verificar parámetros contra la primera firma vigente.
  const firmas = [...clavesFinales].map((c) => funciones.get(c)).filter(Boolean);
  const f = firmas.find((x) => x.args.length) || firmas[0];
  const faltantes = l.claves.filter((k) => !f.args.includes(k));
  if (faltantes.length) {
    err(`${l.rpc}: parámetro(s) del frontend sin argumento en SQL: ${faltantes.join(', ')} (SQL: ${f.args.join(', ') || 'sin args'})`);
  }
  const roles = [];
  if (acceso(f, 'anon')) roles.push('anon');
  if (acceso(f, 'authenticated')) roles.push('authenticated');
  if (firmas.length > 1) warn(`${l.rpc}: ${firmas.length} firmas vigentes (¿overload?)`);
  if (!roles.length) err(`${l.rpc}: ninguna rol de cliente puede ejecutarla`);
  console.log(`  ✓ ${l.rpc.padEnd(28)} args=${String(f.args.length).padStart(2)} · execute: ${roles.join(', ') || '—'}`);
}

// ---------------------------------------------------------------------------
// 4. Funciones SQL sin uso en src/ (candidatas a código muerto)
// ---------------------------------------------------------------------------
console.log('\n── Funciones SQL sin uso en src/ ────────────────────────────');
const usadas = new Set(llamadas.map((l) => l.rpc));
for (const clave of [...new Set([...porNombre.keys()])].sort()) {
  if (usadas.has(clave)) continue;
  const firmas = [...porNombre.get(clave)].map((c) => funciones.get(c)).filter(Boolean);
  if (!firmas.length) continue; // firma histórica ya eliminada por un drop
  const publica = firmas.some((f) => acceso(f, 'anon') || acceso(f, 'authenticated'));
  console.log(`  · ${clave.padEnd(34)} ${publica ? 'PÚBLICA sin uso' : 'interna'}`);
}

// ---------------------------------------------------------------------------
// 5. Grants de escritura/lectura por tabla para anon (solo lo que src lee)
// ---------------------------------------------------------------------------
console.log('\n── Lecturas de tablas en src/ ────────────────────────────────');
const lecturas = new Map(); // tabla -> Set(columnas)
for (const ruta of archivosDe(SRC)) {
  const texto = readFileSync(ruta, 'utf8');
  const regex = /\.from\('([a-z_]+)'\)\s*\.select\('([^']*)'\)/g;
  let m;
  while ((m = regex.exec(texto))) {
    const cols = m[2]
      .split(',')
      .map((c) => c.trim().split(/[:(]/)[0].trim())
      .filter(Boolean);
    if (!lecturas.has(m[1])) lecturas.set(m[1], new Set());
    for (const c of cols) lecturas.get(m[1]).add(c);
  }
}
for (const [tabla, cols] of [...lecturas].sort()) {
  console.log(`  · ${tabla.padEnd(24)} ${[...cols].join(', ')}`);
}

// ---------------------------------------------------------------------------
// 6. Modo LIVE: inventario real de la base (drift vs migraciones)
// ---------------------------------------------------------------------------
if (process.env.LIVE === '1') {
  const { cargarEntorno, cliente } = await import('./_entorno.mjs');
  const env = cargarEntorno();
  const anon = cliente(env.url, env.anon, `audit-live-${Date.now()}`);

  const valorPorTipo = (tipo) => {
    const t = tipo.toLowerCase();
    if (t.startsWith('uuid')) return '00000000-0000-0000-0000-000000000000';
    if (t.startsWith('text') || t.startsWith('varchar') || t.startsWith('char')) return 'x';
    if (t.includes('bool')) return true;
    if (t.startsWith('json')) return {};
    if (t.startsWith('interval')) return '1 minute';
    if (t.startsWith('timestamp') || t.startsWith('date') || t.startsWith('time')) return '2026-01-01T00:00:00Z';
    return 1; // int, numeric, etc.
  };

  console.log(`\n── Inventario LIVE (${env.archivo}) ─────────────────────────`);
  const nombres = [...new Set([...porNombre.keys()])].sort();
  let drift = 0;
  for (const nombre of nombres) {
    const firmas = [...porNombre.get(nombre)].map((c) => funciones.get(c)).filter(Boolean);
    if (!firmas.length) continue;
    const f = firmas[0];
    if (f.esTrigger) continue; // PostgREST no expone funciones de trigger
    const args = {};
    for (let i = 0; i < f.args.length; i++) args[f.args[i]] = valorPorTipo((f.tipos.split(', ')[i] || 'text'));
    const { error } = await anon.rpc(nombre, args);
    const msg = String(error?.message || '');
    const esPublica = acceso(f, 'anon') || acceso(f, 'authenticated');
    if (/could not find the function|schema cache/i.test(msg)) {
      // Una función interna puede no estar en el schema cache de PostgREST
      // (sin execute para clientes): eso es correcto. Solo es drift si el
      // frontend debería poder llamarla.
      if (esPublica) {
        drift++;
        err(`LIVE: ${f.clave} NO existe en la base (drift)`);
      }
    } else if (/permission denied/i.test(msg)) {
      // existe pero es interna: correcto para helpers.
    } else {
      const ejecutable = !error ? 'OK' : `error de negocio: ${msg.slice(0, 40)}`;
      console.log(`  ✓ ${f.clave.padEnd(40)} existe (anon: ${f.grants.anon || f.grants.public ? 'ejecutable' : 'sin permiso'}) · ${ejecutable}`);
    }
  }
  console.log(`  Drift detectado: ${drift}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  RESULTADO: ${errores} errores · ${avisos} avisos`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(errores > 0 ? 1 : 0);
