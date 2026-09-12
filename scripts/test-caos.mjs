// scripts/test-caos.mjs
//
// TEST DE CAOS — la red se cae en medio de la partida: ¿se recupera?
//
//   FASE 1  Un jugador pierde Realtime (WSS) mientras el host rota pregunta.
//           Al reconectar, su REST + polling reconstruyen el estado exacto.
//   FASE 2  Ese jugador responde con la pregunta que ve: se acepta; el
//           doble-tap se rechaza sin doble puntaje.
//   FASE 3  Un cliente que perdió eventos se recupera con la instantánea del
//           host (broadcast `publicarEstado`) y el polling de respaldo.
//
// Uso: ENTORNO=staging node scripts/test-caos.mjs

import { cargarEntorno, cliente, datosJugador } from './_entorno.mjs';

const env = cargarEntorno();
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const MARCA = Date.now().toString(36);

let pasadas = 0;
let falladas = 0;
function verificar(descripcion, condicion, detalle = '') {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${descripcion}`);
  } else {
    falladas++;
    console.error(`  ✗ FALLO: ${descripcion}${detalle ? ` (${detalle})` : ''}`);
  }
}

console.log('══════════════════════════════════════════════════════════════');
console.log(`  KALDORA — TEST DE CAOS (entorno: ${env.archivo})`);
console.log('══════════════════════════════════════════════════════════════');

const host = cliente(env.url, env.anon, `caos-host-${MARCA}`);
const login = await host.auth.signInWithPassword({ email: env.hostEmail, password: env.hostPass });
if (login.error) {
  console.error('✗ Login del host falló:', login.error.message);
  process.exit(2);
}

const { data: sala, error: errSala } = await host.rpc('crear_sala');
if (errSala) {
  console.error('✗ crear_sala:', errSala.message);
  process.exit(2);
}
console.log(`  Sala ${sala.codigo}`);

// --- 4 jugadores reales ------------------------------------------------------
const jugadores = [];
for (let i = 0; i < 4; i++) {
  const c = cliente(env.url, env.anon, `caos-${i}-${MARCA}`);
  const { data, error } = await c.rpc('unirse_sala', {
    p_codigo: sala.codigo,
    p_nickname: `Caos${i + 1}`,
    p_icono: 'Star',
    p_color: 'bg-purple-500',
    ...datosJugador(env, MARCA, i + 1),
  });
  if (error) {
    console.error(`✗ unirse #${i}:`, error.message);
    process.exit(2);
  }
  jugadores.push({ client: c, token: data.token, id: data.idJugador, nickname: data.nickname, eventos: 0, canal: null });
}

// Suscripción espejo del app (filtrada + DELETE).
function suscribir(j) {
  const canal = j.client
    .channel(`sala:${sala.id}`, { config: { presence: { key: j.token } } })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'salas', filter: `id=eq.${sala.id}` }, () => {
      j.eventos++;
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jugadores', filter: `id_sala=eq.${sala.id}` }, () => {
      j.eventos++;
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jugadores', filter: `id_sala=eq.${sala.id}` }, () => {
      j.eventos++;
    })
    .on('broadcast', { event: 'ev' }, ({ payload }) => {
      if (payload?.tipo === 'sala') j.snapshot = payload;
    })
    .subscribe((s) => s === 'SUBSCRIBED' && canal.track({ tipo: 'jugador', de: j.token }));
  j.canal = canal;
}
jugadores.forEach(suscribir);
await esperar(2500);

// --- Partida: trivia ---------------------------------------------------------
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'trivia' });
await host.rpc('trivia_siguiente', { p_sala: sala.id });
await esperar(1500);
const { data: s1 } = await host.from('salas').select('juego').eq('id', sala.id).single();
const pregunta1 = s1.juego.pregunta_id;

console.log('\n═══ FASE 1 — Realtime caído durante una rotación de pregunta ═══');
verificar('los 4 jugadores recibieron el cambio de estado', jugadores.every((j) => j.eventos > 0), JSON.stringify(jugadores.map((j) => j.eventos)));

const p1 = jugadores[0];
const antes = p1.eventos;
await p1.client.realtime.disconnect(); // se cae el WSS de p1 (REST sigue vivo)
await esperar(1200);

await host.rpc('trivia_siguiente', { p_sala: sala.id }); // el host rota la pregunta
await esperar(2500);
const { data: s2 } = await host.from('salas').select('juego').eq('id', sala.id).single();
const pregunta2 = s2.juego.pregunta_id;
verificar('la pregunta rotó en el servidor', pregunta2 && pregunta2 !== pregunta1);
verificar('p1 (desconectado) NO recibió la rotación por Realtime', p1.eventos === antes, `eventos ${p1.eventos} vs ${antes}`);
verificar(
  'los otros 3 sí la recibieron',
  jugadores.slice(1).every((j) => j.eventos > 0)
);

// Reconstrucción: REST del estado (lo que hace recargar()/polling al volver).
p1.client.realtime.connect();
await esperar(1500);
const [{ data: salaRest }, { data: jugadoresRest }] = await Promise.all([
  // Columnas explícitas: anon ya no tiene SELECT sobre id_anfitrion.
  p1.client
    .from('salas')
    .select('id, codigo, estado, juego_actual, juego, creado_en')
    .eq('id', sala.id)
    .maybeSingle(),
  p1.client.from('jugadores').select('*').eq('id_sala', sala.id),
]);
verificar('REST reconstruye el estado exacto al reconectar', salaRest?.juego?.pregunta_id === pregunta2);
verificar('REST reconstruye la lista de jugadores', (jugadoresRest || []).length === 4);

console.log('\n═══ FASE 2 — Responder tras reconectar (sin doble puntaje) ═══');
const { data: r1 } = await p1.client.rpc('trivia_responder', {
  p_token: p1.token,
  p_opcion: 0,
  p_pregunta_id: pregunta2,
});
verificar('la respuesta posterior al corte se acepta', !!r1 && typeof r1.correcta === 'boolean');

const doble = await p1.client.rpc('trivia_responder', {
  p_token: p1.token,
  p_opcion: 2,
  p_pregunta_id: pregunta2,
});
verificar(
  'el reenvío (doble-tap / retry) se rechaza como "Ya respondiste"',
  /ya respondiste/i.test(doble.error?.message || '')
);

const { data: filas } = await p1.client
  .from('trivia_respuestas')
  .select('id')
  .eq('id_jugador', p1.id)
  .eq('id_pregunta', pregunta2);
verificar('una sola fila de respuesta para esa pregunta', (filas || []).length === 1);

const { data: yo } = await p1.client.from('jugadores').select('puntos').eq('id', p1.id).single();
verificar('puntos aplicados una sola vez (≤ 1000)', (yo?.puntos || 0) <= 1000, `puntos=${yo?.puntos}`);

console.log('\n═══ FASE 3 — Recuperación por instantánea del host ═══');
const p3 = jugadores[2];
await p3.client.realtime.disconnect();
await p3.client.removeChannel(p3.canal); // el canal viejo ya no sirve
await esperar(800);
p3.snapshot = null;

// El host publica la instantánea en el MISMO topic de la sala, como
// `publicarEstado` (useSalaRealtime.enviar).
const [{ data: salaSnap }, { data: jugSnap }] = await Promise.all([
  host.from('salas').select('*').eq('id', sala.id).maybeSingle(),
  host.from('jugadores').select('*').eq('id_sala', sala.id),
]);
const canalHost = host.channel(`sala:${sala.id}`);
await new Promise((r) => canalHost.subscribe((s) => s === 'SUBSCRIBED' && r()));
await canalHost.send({
  type: 'broadcast',
  event: 'ev',
  payload: { tipo: 'sala', idSala: sala.id, sala: salaSnap, jugadores: jugSnap },
});
await esperar(1200);
verificar('p3 desconectado no recibe la instantánea', p3.snapshot === null);

// p3 vuelve: canal nuevo + snapshot reenviado por el host (reconexión real).
p3.client.realtime.connect();
await esperar(1500);
const canalP3 = p3.client
  .channel(`sala:${sala.id}`, { config: { presence: { key: p3.token } } })
  .on('broadcast', { event: 'ev' }, ({ payload }) => {
    if (payload?.tipo === 'sala') p3.snapshot = payload;
  });
await new Promise((r) => canalP3.subscribe((s) => s === 'SUBSCRIBED' && r()));
await canalHost.send({
  type: 'broadcast',
  event: 'ev',
  payload: { tipo: 'sala', idSala: sala.id, sala: salaSnap, jugadores: jugSnap },
});
await esperar(1500);
verificar(
  'p3 reconectado recupera la instantánea (sala + jugadores)',
  p3.snapshot?.sala?.id === sala.id && (p3.snapshot?.jugadores || []).length === 4
);

// --- Limpieza ---------------------------------------------------------------
for (const j of jugadores) await j.client.removeAllChannels().catch(() => {});
await host.removeAllChannels().catch(() => {});
await host.rpc('borrar_sala', { p_sala: sala.id });

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  RESULTADO: ${pasadas} OK · ${falladas} fallos`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(falladas === 0 ? 0 : 1);
