// scripts/test-concurrencia.mjs
//
// TEST DE ESTRÉS — 10 jugadores simultáneos por los 4 juegos de KALDORA.
// Simula el peor caso realista: todo el mundo acciona AL MISMO TIEMPO.
//
//   FASE 1  Unión simultánea: 12 intentos (2 con nickname duplicado) → 10 entran.
//   FASE 2  TRIVIA: 10 respuestas al mismo instante + 10 re-respuestas (doble-tap).
//   FASE 3  SUPERVIVENCIA: 7 responden simultáneo (5 bien/2 mal), 3 callados;
//           procesar disparado por 3 clientes a la vez (idempotencia); ronda 2
//           sin respuestas → eliminación masiva.
//   FASE 4  BASTA: 50 upserts simultáneos, carrera de "¡BASTA!" (2 declaran a la
//           vez), cierre por 3 clientes simultáneo, recálculo idempotente.
//   FASE 5  ROSCO: 4 rondas × 10 jugadores contestando en paralelo con la
//           respuesta correcta, más carrera enviar+pasar del mismo jugador
//           (regresión del lost update del jsonb).
//   FASE 6  INTEGRIDAD: perfiles × 10 vivos antes y después de borrar la sala.
//
// Uso: node scripts/test-concurrencia.mjs   (lee .env, golpea Supabase REAL)

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readFileSync } from 'node:fs';

for (const linea of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const SUPA_URL = process.env.VITE_SUPABASE_URL;
const ANON = process.env.VITE_SUPABASE_ANON_KEY;
const N = 10; // jugadores concurrentes

let pasadas = 0;
let falladas = 0;
let rpcs = 0;
const fallos = [];
function verificar(descripcion, condicion) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${descripcion}`);
  } else {
    falladas++;
    fallos.push(descripcion);
    console.error(`  ✗ FALLO: ${descripcion}`);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
async function disparoSimultaneo(promesas) {
  const t0 = Date.now();
  const rs = await Promise.allSettled(promesas);
  rpcs += promesas.length;
  const ok = rs.filter((r) => r.status === 'fulfilled' && !r.value?.error);
  const errores = rs.filter((r) => r.status === 'rejected' || r.value?.error);
  return { ok, errores, rs, ms: Date.now() - t0 };
}

// --- clientes (almacenamiento aislado por instancia) --------------------------
function crearAlmacen() {
  const mapa = new Map();
  return {
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => mapa.set(k, String(v)),
    removeItem: (k) => mapa.delete(k),
  };
}
const TRANSPORT = { realtime: { transport: WebSocket } };
const cliente = (key) =>
  createClient(SUPA_URL, ANON, { ...TRANSPORT, auth: { storage: crearAlmacen(), storageKey: key } });

const host = cliente('stress-host');
const anon = cliente('stress-anon');
const clientes = Array.from({ length: N + 2 }, (_, i) => cliente(`stress-j${i + 1}`));

const EMAIL_HOST = 'admin31@admin.com';
const PASS_HOST = '2AdmIN2026';
const MARCA = Date.now().toString(36);
const datosDe = (i) => ({
  p_nombre: `Stress${i}`,
  p_apellido: `Prueba ${MARCA}`,
  p_telefono: `+54 9 11 5555-${String(1000 + i)}`,
  p_correo: `stress.${MARCA}.${i}@example.com`,
});

console.log('══════════════════════════════════════════════════════════');
console.log('  KALDORA — TEST DE ESTRÉS: 10 jugadores concurrentes');
console.log('══════════════════════════════════════════════════════════');

// =============================================================================
console.log('\n═══ 0. Autenticación + sala ═══');
// =============================================================================
const login = await host.auth.signInWithPassword({ email: EMAIL_HOST, password: PASS_HOST });
if (login.error) {
  console.error('  ✗ No se pudo loguear el host:', login.error.message);
  process.exit(2);
}
const { data: sala, error: errSala } = await host.rpc('crear_sala');
verificar('crear_sala OK', !errSala && /^\d{6}$/.test(sala?.codigo || ''));
console.log(`     sala ${sala.codigo} · ${N} jugadores · todo simultáneo`);

// =============================================================================
console.log('\n═══ 1. UNIÓN SIMULTÁNEA (12 intentos, 2 nicknames duplicados) ═══');
// =============================================================================
let sesiones = [];
{
  const t0 = Date.now();
  const intentos = clientes.map((c, i) => {
    const dup = i >= N; // los últimos 2 intentan el nickname del jugador 1
    return c.rpc('unirse_sala', {
      p_codigo: sala.codigo,
      p_nickname: dup ? 'Stress1' : `Stress${i + 1}`,
      p_icono: 'Star',
      p_color: 'bg-purple-500',
      ...datosDe(i + 1),
    });
  });
  const rs = await Promise.allSettled(intentos);
  rpcs += intentos.length;
  const ok = rs.filter((r) => r.status === 'fulfilled' && !r.value.error);
  const dupRechazados = rs.filter(
    (r) => String(r.value?.error?.message || r.reason?.message || '').includes('ya está en uso')
  );
  verificar(`union simultánea: ${N} exitosas de 12 intentos (${Date.now() - t0} ms)`, ok.length === N);
  verificar(`2 nicknames duplicados rechazados con mensaje limpio (got ${dupRechazados.length})`, dupRechazados.length === 2);
  verificar('cada jugador recibió token de 32 hex', ok.every((r) => r.value.data?.token?.length === 32));

  sesiones = ok.map((r, i) => ({
    i,
    client: clientes[rs.indexOf(r)],
    token: r.value.data.token,
    id: r.value.data.idJugador,
    nickname: r.value.data.nickname,
    correo: datosDe(r.value.data.nickname.match(/\d+/)[0]).p_correo,
  }));
}
{
  const perfiles = await Promise.allSettled(sesiones.map((s) => anon.rpc('perfil_por_correo', { p_correo: s.correo })));
  rpcs += N;
  verificar('los 10 registros quedaron en la base (perfil_por_correo)',
    perfiles.every((r) => r.status === 'fulfilled' && r.value?.data?.existe === true));
}

// =============================================================================
console.log('\n═══ 2. TRIVIA — 10 respuestas exactamente simultáneas ═══');
// =============================================================================
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'trivia' });
const sigT = await host.rpc('trivia_siguiente', { p_sala: sala.id, p_duracion_ms: 8000 });
verificar('trivia_siguiente OK', !sigT.error);
const { data: juegoT } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const { data: pregTInfo } = await host
  .from('preguntas_trivia').select('id, indice_correcto').eq('id', juegoT.juego.pregunta_id).single();
verificar('el host ve el índice correcto de la pregunta', pregTInfo?.indice_correcto !== undefined);

{
  // 7 correctos + 3 incorrectos, TODOS al mismo tiempo.
  const incorrecta = (pregTInfo.indice_correcto + 1) % 4;
  const resultados = await disparoSimultaneo(
    sesiones.map((s, i) => s.client.rpc('trivia_responder', {
      p_token: s.token,
      p_opcion: i < 7 ? pregTInfo.indice_correcto : incorrecta,
      p_pregunta_id: juegoT.juego.pregunta_id,
    }))
  );
  verificar(`trivia: 10/10 respuestas aceptadas sin errores (${resultados.ms} ms)`, resultados.ok.length === N);

  const correctos = resultados.rs.slice(0, 7).filter((r) => r.status === 'fulfilled' && r.value?.data?.correcta === true);
  verificar('los 7 correctos puntuaron (>800 por responder al instante)',
    correctos.length === 7 && correctos.every((r) => r.value.data.puntos > 800));
  const incorrectos = resultados.rs.slice(7).filter((r) => r.status === 'fulfilled' && r.value?.data?.correcta === false);
  verificar('los 3 incorrectos: 0 pts y racha reiniciada',
    incorrectos.length === 3 && incorrectos.every((r) => r.value.data.puntos === 0 && r.value.data.racha === 0));
  verificar('racha=1 para los 7 correctos (sin dobles incrementos)',
    resultados.rs.slice(0, 7).every((r) => r.value?.data?.racha === 1));

  // DOBLE-TAP: los 10 re-responden simultáneamente → todos rechazados.
  const doble = await disparoSimultaneo(sesiones.map((s) =>
    s.client.rpc('trivia_responder', {
      p_token: s.token,
      p_opcion: pregTInfo.indice_correcto,
      p_pregunta_id: juegoT.juego.pregunta_id,
    })));
  verificar(`doble-tap: 10/10 rechazados con 'Ya respondiste' (${doble.ms} ms)`,
    doble.errores.length === N && doble.errores.every((e) =>
      String(e.value?.error?.message || e.reason?.message || '').includes('Ya respondiste')));

  // Integridad: la auditoría de la base debe reflejar exactamente lo devuelto.
  // (correcta/puntos son columnas solo del host: el anon no puede leerlas.)
  const { data: filas } = await host.from('trivia_respuestas')
    .select('id_jugador, correcta, puntos').eq('id_sala', sala.id).eq('id_pregunta', juegoT.juego.pregunta_id);
  verificar('auditoría: exactamente 10 filas para la pregunta', (filas || []).length === N);
  const sumaRPC = resultados.rs.reduce((a, r) => a + (r.value?.data?.puntos || 0), 0);
  const sumaBD = (filas || []).reduce((a, r) => a + (r.puntos || 0), 0);
  verificar(`integridad transaccional: suma de puntos RPC (${sumaRPC}) == base (${sumaBD})`, sumaRPC === sumaBD);
}

// =============================================================================
console.log('\n═══ 3. SUPERVIVENCIA — respuestas y procesar concurrentes ═══');
// =============================================================================
await host.rpc('volver_al_lobby', { p_sala: sala.id });
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'supervivencia' });
const sigS = await host.rpc('supervivencia_siguiente', { p_sala: sala.id, p_duracion_ms: 5000 });
verificar('supervivencia_siguiente OK', !sigS.error);
const { data: juegoS } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const { data: pregSInfo } = await host
  .from('preguntas_supervivencia').select('id, es_verdadera').eq('id', juegoS.juego.pregunta_id).single();

{
  // 5 correctos + 2 incorrectos simultáneos; 3 callados.
  const res = await disparoSimultaneo(sesiones.map((s, i) => {
    if (i >= 7) return Promise.resolve({ data: { callado: true } });
    const valor = i < 5 ? pregSInfo.es_verdadera : !pregSInfo.es_verdadera;
    return s.client.rpc('supervivencia_responder', { p_token: s.token, p_respuesta: valor });
  }));
  const respondieron = res.rs.filter((r) => r.status === 'fulfilled' && r.value?.data && !r.value.data.callado);
  verificar('supervivencia: 7 respuestas aceptadas, 3 callados', respondieron.length === 7);
  verificar('los 5 correctos viven (+25)',
    respondieron.slice(0, 5).every((r) => r.value.data.correcta === true && r.value.data.eliminado === false));
  verificar('los 2 incorrectos eliminados al instante',
    respondieron.slice(5).every((r) => r.value.data.correcta === false && r.value.data.eliminado === true));

  // Al vencer la ventana: 3 clientes disparan `procesar` A LA VEZ.
  await esperar(5500);
  const proc = await disparoSimultaneo([
    host.rpc('supervivencia_procesar', { p_sala: sala.id, p_pregunta_id_esperada: juegoS.juego.pregunta_id }),
    sesiones[0].client.rpc('supervivencia_procesar', { p_sala: sala.id, p_pregunta_id_esperada: juegoS.juego.pregunta_id }),
    sesiones[9].client.rpc('supervivencia_procesar', { p_sala: sala.id, p_pregunta_id_esperada: juegoS.juego.pregunta_id }),
  ]);
  verificar('procesar ×3 simultáneos: sin errores (idempotente)', proc.errores.length === 0);

  const { data: jbd } = await anon.from('jugadores').select('nickname, puntos, eliminado').eq('id_sala', sala.id);
  const eliminadosBD = (jbd || []).filter((j) => j.eliminado);
  const vivos = (jbd || []).filter((j) => !j.eliminado);
  verificar(`exactamente 5 eliminados (2 errados + 3 callados) — got ${eliminadosBD.length}`, eliminadosBD.length === 5);
  verificar('5 vivos con +25 exacto', vivos.length === 5 && vivos.every((j) => j.puntos === 25));

  // Ronda 2: nadie responde → el procesar elimina a los 5 vivos.
  await host.rpc('supervivencia_siguiente', { p_sala: sala.id, p_duracion_ms: 4000 });
  const { data: juegoS2 } = await anon.from('salas').select('juego').eq('id', sala.id).single();
  await esperar(4500);
  await host.rpc('supervivencia_procesar', { p_sala: sala.id, p_pregunta_id_esperada: juegoS2.juego.pregunta_id });
  const { data: jbd2 } = await anon.from('jugadores').select('eliminado').eq('id_sala', sala.id);
  verificar('ronda 2 sin respuestas: 10/10 eliminados', (jbd2 || []).every((j) => j.eliminado));
}

// =============================================================================
console.log('\n═══ 4. BASTA — 50 upserts, carrera de BASTA, cierre triple ═══');
// =============================================================================
await host.rpc('volver_al_lobby', { p_sala: sala.id });
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'basta' });
const rondaB = await host.rpc('basta_iniciar_ronda', { p_sala: sala.id });
verificar('basta_iniciar_ronda OK', !rondaB.error && rondaB.data?.categorias?.length === 5);
const { data: juegoB } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const cats = juegoB.juego.categorias;
const letraB = juegoB.juego.letra;

{
  // 10 jugadores × 5 categorías SIMULTÁNEO (50 upserts). Los pares (1,2) y
  // (3,4) comparten palabra para probar la unicidad bajo carga.
  const promesas = [];
  sesiones.forEach((s, i) => {
    cats.forEach((c, k) => {
      const compartida = (k === 0 && (i === 0 || i === 1)) || (k === 1 && (i === 2 || i === 3));
      const texto = compartida
        ? `Dup${letraB}${k}`
        : `P${i + 1}C${k}${letraB}${Math.random().toString(36).slice(2, 6)}`;
      promesas.push(s.client.rpc('basta_enviar', { p_token: s.token, p_id_categoria: c, p_texto: texto }));
    });
  });
  const up = await disparoSimultaneo(promesas);
  verificar(`basta: 50/50 palabras aceptadas simultáneamente (${up.ms} ms)`, up.ok.length === 50);

  // Carrera de BASTA: 2 jugadores declaran completo AL MISMO TIEMPO.
  const carrera = await Promise.allSettled([
    sesiones[0].client.rpc('basta_declarar_completo', { p_token: sesiones[0].token }),
    sesiones[1].client.rpc('basta_declarar_completo', { p_token: sesiones[1].token }),
  ]);
  rpcs += 2;
  const primeros = carrera.filter((r) => r.status === 'fulfilled' && r.value?.data?.soyPrimero === true);
  verificar('carrera de BASTA: exactamente UNO dispara la cuenta letal', primeros.length === 1);

  const { data: juegoB2 } = await anon.from('salas').select('juego').eq('id', sala.id).single();
  verificar('fase → cuenta_atras con deadline', juegoB2.juego.fase === 'cuenta_atras' && Boolean(juegoB2.juego.deadline));

  // Al vencer el deadline letal: host + 2 jugadores cierran A LA VEZ.
  await esperar(10400);
  const cierre = await disparoSimultaneo([
    host.rpc('basta_cerrar_ronda', { p_sala: sala.id }),
    sesiones[2].client.rpc('basta_cerrar_ronda', { p_sala: sala.id }),
    sesiones[3].client.rpc('basta_cerrar_ronda', { p_sala: sala.id }),
  ]);
  verificar('cierre triple simultáneo sin errores', cierre.errores.length === 0);

  // Integridad: puntos del jugador == suma de sus respuestas; pares = repetidas.
  const { data: respuestas } = await anon.from('respuestas_basta')
    .select('id_jugador, id_categoria, texto, valida, unico, puntos').eq('id_sala', sala.id);
  const { data: jbd } = await anon.from('jugadores').select('id, nickname, puntos').eq('id_sala', sala.id);
  verificar(`respuestas de la ronda: ${(respuestas || []).length}/50 filas`, (respuestas || []).length === 50);

  const sumaPorJugador = {};
  (respuestas || []).forEach((r) => { sumaPorJugador[r.id_jugador] = (sumaPorJugador[r.id_jugador] || 0) + (r.puntos || 0); });
  const integridad = (jbd || []).every((j) => (j.puntos || 0) === (sumaPorJugador[j.id] || 0));
  verificar('integridad: puntos de cada jugador == suma de sus respuestas', integridad);

  const duplicadas = (respuestas || []).filter((r) => r.unico === false);
  verificar(`palabras compartidas detectadas como repetidas (${duplicadas.length} ≥ 4)`, duplicadas.length >= 4);

  // Recálculo idempotente: cerrar de nuevo no cambia nada.
  const antes = (jbd || []).map((j) => j.puntos).join(',');
  await host.rpc('basta_cerrar_ronda', { p_sala: sala.id });
  const { data: jbd2 } = await anon.from('jugadores').select('puntos').eq('id_sala', sala.id);
  verificar('recálculo idempotente: totales idénticos', (jbd2 || []).map((j) => j.puntos).join(',') === antes);
}

// =============================================================================
console.log('\n═══ 5. ROSCO — 4 rondas × 10 en paralelo + carrera enviar/pasar ═══');
// =============================================================================
await host.rpc('volver_al_lobby', { p_sala: sala.id });
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'rosco' });
const iniR = await host.rpc('rosco_iniciar', { p_sala: sala.id, p_duracion_seg: 600 });
verificar('rosco_iniciar OK (10 min)', !iniR.error);

{
  let sinErrores = true;
  for (let rondaR = 1; rondaR <= 4; rondaR++) {
    const estados = await Promise.all(sesiones.map((s) => s.client.rpc('rosco_estado', { p_token: s.token })));
    rpcs += N;
    const correctas = await Promise.all(estados.map((e) =>
      host.from('preguntas').select('respuesta').eq('id', e.data?.rosco?.q).single()));
    const envios = await disparoSimultaneo(sesiones.map((s, i) =>
      s.client.rpc('rosco_enviar', { p_token: s.token, p_respuesta: correctas[i].data?.respuesta || 'zzzz' })));
    if (envios.ok.length !== N) {
      sinErrores = false;
      envios.errores.slice(0, 3).forEach((r) =>
        console.log('       error:', r.value?.error?.message || r.reason?.message));
    }
  }
  verificar('rosco: 4 rondas × 10 respuestas correctas simultáneas, cero errores', sinErrores);

  // Integridad por jugador: 4 auditorías, todos los estados en {1}, +400 pts.
  const { data: audit } = await anon.from('rosco_respuestas').select('id_jugador, letra, correcta, puntos').eq('id_sala', sala.id);
  const { data: jbdR } = await anon.from('jugadores').select('id, nickname, puntos, rosco').eq('id_sala', sala.id);
  const filasPorJugador = {};
  (audit || []).forEach((r) => { (filasPorJugador[r.id_jugador] ||= []).push(r); });
  const todoBien = (jbdR || []).every((j) => {
    const filas = filasPorJugador[j.id] || [];
    if (filas.length !== 4) return false;
    const estados = j.rosco?.e || {};
    return filas.every((f) => estados[f.letra] === 1) && j.puntos === 400;
  });
  verificar('integridad rosco: 4 auditorías por jugador, estados=1, +400 pts exactos', todoBien);

  // CARRERA enviar+pasar del MISMO jugador (regresión del lost update).
  // Invariante tras el fix: letra AUDITADA ⇒ estado ∈ {1,2}; estado 3 (pasapalabra)
  // ⇒ SIN auditoría. Con el bug viejo quedaban letras "pendientes" con
  // auditoría insertada → rosco trabado (unique_violation al reintentar).
  for (const s of [sesiones[0], sesiones[1]]) {
    const est = await s.client.rpc('rosco_estado', { p_token: s.token });
    const { data: pregActual } = await host.from('preguntas').select('respuesta').eq('id', est.data?.rosco?.q).single();
    const carrera = await Promise.allSettled([
      s.client.rpc('rosco_enviar', { p_token: s.token, p_respuesta: pregActual?.respuesta || 'zzz' }),
      s.client.rpc('rosco_pasar', { p_token: s.token }),
    ]);
    rpcs += 2;
    const errorFeo = carrera.find((r) => {
      const msg = String(r.value?.error?.message || r.reason?.message || '');
      return r.status === 'rejected' || (r.value?.error && !msg.includes('Ya respondiste'));
    });
    if (errorFeo) {
      verificar(`carrera enviar+pasar (${s.nickname}): sin errores crudos`, false);
      console.log('       error:', errorFeo.value?.error?.message || errorFeo.reason?.message);
    }
  }

  // INVARIANTE global del rosco: toda letra auditada tiene estado 1/2.
  const { data: auditFinal } = await anon.from('rosco_respuestas').select('id_jugador, letra').eq('id_sala', sala.id);
  const { data: jFinal } = await anon.from('jugadores').select('id, rosco').eq('id_sala', sala.id);
  let corrupto = 0;
  (auditFinal || []).forEach((r) => {
    const j = (jFinal || []).find((x) => x.id === r.id_jugador);
    const estadoLetra = j?.rosco?.e?.[r.letra];
    if (estadoLetra !== 1 && estadoLetra !== 2) corrupto++;
  });
  verificar('INVARIANTE rosco: toda letra auditada tiene estado 1/2 (nadie trabado)', corrupto === 0);
}

// =============================================================================
console.log('\n═══ 6. INTEGRIDAD FINAL — perfiles sobreviven al borrado ═══');
// =============================================================================
await host.rpc('terminar_partida', { p_sala: sala.id });
{
  const perfiles = await Promise.allSettled(sesiones.map((s) => anon.rpc('perfil_por_correo', { p_correo: s.correo })));
  verificar('perfiles ×10 presentes antes de borrar la sala',
    perfiles.every((r) => r.status === 'fulfilled' && r.value?.data?.existe === true));
  await host.rpc('borrar_sala', { p_sala: sala.id });
  const perfiles2 = await Promise.allSettled(sesiones.map((s) => anon.rpc('perfil_por_correo', { p_correo: s.correo })));
  verificar('perfiles ×10 SOBREVIVEN al borrado de la sala (historial persistente)',
    perfiles2.every((r) => r.status === 'fulfilled' && r.value?.data?.existe === true));
}

// =============================================================================
console.log('\n══════════════════════════════════════════════════════════');
console.log(`RESULTADO ESTRÉS: ${pasadas} OK · ${falladas} fallos · ~${rpcs} RPCs concurrentes`);
if (fallos.length) console.log('Fallos: ' + fallos.join(' | '));
console.log('══════════════════════════════════════════════════════════');
process.exit(falladas > 0 ? 1 : 0);
