// scripts/_entorno.mjs
//
// Helper compartido por los scripts de prueba: carga credenciales del
// entorno correcto y crea clientes Supabase aislados.
//
//   ENTORNO=staging  -> .env.staging (proyecto espejo, no toca producción)
//   (sin variable)   -> .env (producción)
//
// Las claves nunca se imprimen.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');

function parsearEnv(contenido) {
  return Object.fromEntries(
    contenido
      .split('\n')
      .filter((l) => /^\s*[A-Z_][A-Z0-9_]*\s*=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')];
      })
  );
}

export function cargarEntorno() {
  const staging = process.env.ENTORNO === 'staging';
  const archivo = staging ? '.env.staging' : '.env';
  let env = {};
  try {
    env = parsearEnv(readFileSync(join(RAIZ, archivo), 'utf8'));
  } catch {
    throw new Error(`No se pudo leer ${archivo}. ¿Corriste el setup?`);
  }

  const url = staging ? env.STAGING_SUPABASE_URL : env.VITE_SUPABASE_URL;
  const anon = staging ? env.STAGING_ANON_KEY : env.VITE_SUPABASE_ANON_KEY;
  const service = staging ? env.STAGING_SERVICE_ROLE_KEY : env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !anon) {
    throw new Error(`Faltan credenciales en ${archivo} (URL/anon key)`);
  }

  return {
    staging,
    archivo,
    url,
    anon,
    service: service || null,
    hostEmail: env.HOST_EMAIL || 'admin31@admin.com',
    hostPass: env.HOST_PASS || '2AdmIN2026',
  };
}

/**
 * service_role key del proyecto LINKEADO, obtenida en el momento vía CLI (no
 * se guarda en archivos). Se usa para limpiezas de tests en producción.
 */
export function servicioDeCli() {
  const ref = readFileSync(join(RAIZ, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  const salida = execFileSync(
    'npx',
    ['supabase', 'projects', 'api-keys', '--project-ref', ref, '-o', 'json'],
    { encoding: 'utf8', cwd: RAIZ, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  const sr = JSON.parse(salida).find((k) => k.name === 'service_role');
  if (!sr?.api_key) throw new Error('No se pudo obtener la service_role key');
  return sr.api_key;
}

export function crearAlmacen() {
  const mapa = new Map();
  return {
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => mapa.set(k, String(v)),
    removeItem: (k) => mapa.delete(k),
  };
}

/** Cliente Supabase aislado (sesión y storage propios). */
export function cliente(url, anon, clave) {
  return createClient(url, anon, {
    auth: { storage: crearAlmacen(), storageKey: clave, persistSession: true, autoRefreshToken: true },
    realtime: { transport: WebSocket, params: { eventsPerSecond: 30 } },
  });
}

/** Datos válidos y únicos para registrar un jugador de prueba. */
export function datosJugador(entorno, marca, i) {
  return {
    p_nombre: `Carga${i}`,
    p_apellido: `Prueba ${marca}`,
    p_telefono: `+54 9 11 6${String(1000000 + i).slice(-7)}`,
    p_correo: `carga.${marca}.${i}@example.com`,
  };
}

export { RAIZ };
