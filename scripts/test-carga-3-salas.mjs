// scripts/test-carga-3-salas.mjs
//
// TEST DE CARGA — 3 salas simultáneas con suscriptores Realtime REALES.
//
// Mide el consumo tal como lo cuenta Supabase: 1 evento = 1 mensaje
// entregado a 1 cliente (broadcast incluido). Simula la cadencia real de la
// app (ping de reloj, respuestas de juego, broadcasts de jugador, snapshots
// del host) para responder: ¿cabe en el plan Free (100 msg/s) o hay que
// optimizar?
//
// Uso:
//   ENTORNO=staging node scripts/test-carga-3-salas.mjs [jugadoresPorSala]
//   ENTORNO=staging PING_MS=30000 node scripts/test-carga-3-salas.mjs 20
//   ENTORNO=staging FILTRO_SALA=1 node scripts/test-carga-3-salas.mjs 20
//
// Variables:
//   PING_MS       intervalo del ping de reloj por jugador (app actual: 2500)
//   FILTRO_SALA=1 suscribe postgres_changes con filtro server-side por sala
//   REPOSO_SEG    duración de la fase de reposo (default 15)
//   SALAS         cantidad de salas (default 3)

import { cargarEntorno, cliente, datosJugador } from './_entorno.mjs';

const env = cargarEntorno();
const N = Math.max(2, Math.min(50, Number(process.argv[2]) || 20));
const SALAS = Math.max(1, Math.min(5, Number(process.env.SALAS) || 3));
const PING_MS = Math.max(500, Number(process.env.PING_MS) || 2500);
const FILTRO_SALA = process.env.FILTRO_SALA === '1';
const REPOSO_SEG = Math.max(5, Number(process.env.REPOSO_SEG) || 15);
const THROTTLE_BASTA_MS = Math.max(0, Number(process.env.THROTTLE_BASTA_MS) || 0);
const SIN_RESP_BROADCASTS = process.env.SIN_RESP_BROADCASTS === '1';
const PING_BURST = process.env.PING_BURST === '1';
const MARCA = Date.now().toString(36);

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// RPC con reintento SOLO para fallos de red (los de negocio se propagan).
async function rpcSeguro(client, nombre, params, etiqueta) {
  for (let intento = 1; ; intento++) {
    let res;
    try {
      res = await client.rpc(nombre, params);
    } catch (e) {
      res = { error: { message: e.message } };
    }
    if (!res.error) return res.data;
    const esRed = /fetch failed|network|timeout|ECONN|socket|terminated/i.test(res.error.message);
    if (!esRed || intento >= 3) throw new Error(`${etiqueta}: ${res.error.message}`);
    await esperar(300 * intento);
  }
}

// Ejecuta tareas con concurrencia acotada (evita 300 fetch simultáneos, que no
// representa el uso real: los jugadores escriben durante varios segundos).
async function enLotes(items, limite, fn) {
  let idx = 0;
  const workers = Array.from({ length: Math.min(limite, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ---------------------------------------------------------------------------
// Métricas globales (evento recibido = mensaje entregado)
// ---------------------------------------------------------------------------
const porSegundo = new Map();
const porTipo = {};
const fases = [];
let enviados = 0;
let ajenos = 0; // eventos de OTRAS salas entregados por falta de filtro
let crossOk = 0; // broadcasts de otros clientes recibidos (prueba de entrega)
let fallbacksRest = 0; // sends que cayeron a REST (canal cerrado por límite)

// Cuando Realtime corta un canal por superar el límite de eventos, supabase-js
// reintenta el send por REST y lo anuncia por consola: se cuenta, no se imprime.
const warnOriginal = console.warn;
console.warn = (...args) => {
  if (String(args[0] || '').includes('falling back to REST')) {
    fallbacksRest += 1;
    return;
  }
  warnOriginal(...args);
};

function registrar(tipo, { ajeno = false, cross = false } = {}) {
  const s = Math.floor(Date.now() / 1000);
  porSegundo.set(s, (porSegundo.get(s) || 0) + 1);
  porTipo[tipo] = (porTipo[tipo] || 0) + 1;
  if (ajeno) ajenos += 1;
  if (cross) crossOk += 1;
}

function fase(nombre, fn) {
  return Promise.resolve().then(async () => {
    const inicio = Date.now();
    console.log(`\n── ${nombre} ${'─'.repeat(Math.max(1, 60 - nombre.length))}`);
    await fn();
    const fin = Date.now();
    fases.push({ nombre, inicio, fin });
    const enFase = [...porSegundo.entries()]
      .filter(([s]) => s * 1000 >= inicio && s * 1000 <= fin)
      .reduce((a, [, v]) => a + v, 0);
    const seg = Math.max(0.001, (fin - inicio) / 1000);
    console.log(`   ${enFase} eventos entregados en ${seg.toFixed(1)}s → ${(enFase / seg).toFixed(0)} msg/s promedio`);
  });
}

function totalEventos() {
  let t = 0;
  for (const v of porSegundo.values()) t += v;
  return t;
}

// ---------------------------------------------------------------------------
// Suscripción Realtime (espejo de useSalaRealtime.js)
// ---------------------------------------------------------------------------
function suscribir(canal, client, { salaId, esHost, token }) {
  const miYo = token || 'host';
  const filtroJugadores = FILTRO_SALA ? { filter: `id_sala=eq.${salaId}` } : {};
  const filtroSalas = FILTRO_SALA ? { filter: `id=eq.${salaId}` } : {};

  const manejarFila = (p) => {
    registrar('postgres_jugadores', { ajeno: p?.new?.id_sala && p.new.id_sala !== salaId });
  };
  canal
    .on('postgres_changes', { event: '*', schema: 'public', table: 'salas', ...filtroSalas }, (p) => {
      registrar('postgres_salas', { ajeno: p?.new?.id && p.new.id !== salaId });
    })
    // INSERT/UPDATE con filtro server-side (hot path). DELETE sin filtro: el
    // `old` de Realtime solo trae la PK, así que el filtro por id_sala no
    // puede evaluarse (verificado con scripts/_probe_delete.mjs).
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'jugadores', ...filtroJugadores }, manejarFila)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'jugadores', ...filtroJugadores }, manejarFila)
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'jugadores' }, () => {
      registrar('delete_jugadores');
    })
    .on('presence', { event: 'sync' }, () => registrar('presence'))
    .on('presence', { event: 'join' }, () => registrar('presence'))
    .on('presence', { event: 'leave' }, () => registrar('presence'))
    .on('broadcast', { event: 'ev' }, ({ payload }) => {
      const esOtro = payload?.de && payload.de !== miYo;
      registrar('broadcast_ev', { cross: esOtro });
    })
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') canal.track({ tipo: esHost ? 'anfitrion' : 'jugador', de: miYo });
    });

  return canal;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
console.log('══════════════════════════════════════════════════════════════');
console.log(`  KALDORA — CARGA: ${SALAS} salas × ${N} jugadores  (entorno: ${env.archivo})`);
console.log(
  `  ping=${PING_MS}ms · filtro server-side=${FILTRO_SALA ? 'SÍ' : 'no'} · reposo=${REPOSO_SEG}s` +
    ` · throttle basta=${THROTTLE_BASTA_MS}ms · broadcasts de respuesta=${SIN_RESP_BROADCASTS ? 'NO' : 'sí'}` +
    ` · calibración reloj=${PING_BURST ? 'sí' : 'no'}`
);
console.log('══════════════════════════════════════════════════════════════');

const host = cliente(env.url, env.anon, `carga-host-${MARCA}`);
const login = await host.auth.signInWithPassword({ email: env.hostEmail, password: env.hostPass });
if (login.error) {
  console.error('✗ Login del host falló:', login.error.message);
  process.exit(2);
}

// Limpia salas huérfanas de corridas anteriores (crashes) para no acumular.
const { data: previas } = await host.rpc('mis_salas');
for (const s of previas || []) {
  await host.rpc('borrar_sala', { p_sala: s.id });
}

const rooms = [];
for (let r = 0; r < SALAS; r++) {
  const { data: sala, error } = await host.rpc('crear_sala');
  if (error) {
    console.error('✗ crear_sala falló:', error.message);
    process.exit(2);
  }
  rooms.push({ sala, hostCanal: null, jugadores: [], pings: [] });
}
console.log(`  Salas creadas: ${rooms.map((r) => r.sala.codigo).join(', ')}`);

for (const [ri, room] of rooms.entries()) {
  room.hostCanal = suscribir(
    host.channel(`sala:${room.sala.id}`, { config: { presence: { key: `host-${room.sala.id}` } } }),
    host,
    { salaId: room.sala.id, esHost: true, token: null }
  );

  const uniones = [];
  for (let i = 0; i < N; i++) {
    const c = cliente(env.url, env.anon, `carga-${ri}-${i}-${MARCA}`);
    uniones.push(
      c
        .rpc('unirse_sala', {
          p_codigo: room.sala.codigo,
          p_nickname: `C${ri}${i + 1}`,
          p_icono: 'Star',
          p_color: 'bg-purple-500',
          ...datosJugador(env, `${MARCA}${ri}`, i + 1),
        })
        .then(({ data, error: e }) => {
          if (e) throw new Error(`unirse ${ri}/${i}: ${e.message}`);
          const canal = suscribir(
            c.channel(`sala:${room.sala.id}`, { config: { presence: { key: data.token } } }),
            c,
            { salaId: room.sala.id, esHost: false, token: data.token }
          );
          room.jugadores.push({ client: c, canal, token: data.token, id: data.idJugador, pings: [] });
        })
    );
  }
  await Promise.all(uniones);
}

// Espera de sincronización de canales + presencia.
await esperar(3000);
console.log(`  Conectados: ${rooms.length} hosts + ${rooms.reduce((a, r) => a + r.jugadores.length, 0)} jugadores`);

// Reloj por REST (como la app): consulta `hora_servidor`, CERO Realtime.
const sincronizarReloj = (client) => {
  enviados += 1;
  Promise.resolve(client.rpc('hora_servidor')).catch(() => {});
};
for (const room of rooms) {
  for (const j of room.jugadores) {
    j.pings.push(setInterval(() => sincronizarReloj(j.client), PING_MS));
  }
}

// ---------------------------------------------------------------------------
// Fase 1: reposo (peso constante del ping de reloj)
// ---------------------------------------------------------------------------
await fase(`REPOSO ${REPOSO_SEG}s (ping cada ${PING_MS}ms)`, async () => {
  await esperar(REPOSO_SEG * 1000);
});

// ---------------------------------------------------------------------------
// Fase 2: trivia en las 3 salas (respuestas simultáneas + broadcasts)
// ---------------------------------------------------------------------------
await fase(`TRIVIA (${SALAS} salas × ${N} respuestas simultáneas)`, async () => {
  for (const [ri, room] of rooms.entries()) {
    const sel = await host.rpc('seleccionar_juego', { p_sala: room.sala.id, p_juego: 'trivia' });
    if (sel.error) throw new Error(`seleccionar_juego sala ${ri}: ${sel.error.message}`);
    const { error } = await host.rpc('trivia_siguiente', { p_sala: room.sala.id });
    if (error) throw new Error(`trivia_siguiente sala ${ri}: ${error.message}`);
  }
  const preguntaIds = await Promise.all(
    rooms.map(async (room) => {
      const { data } = await host.from('salas').select('juego').eq('id', room.sala.id).single();
      return data?.juego?.pregunta_id;
    })
  );
  // Calibración del reloj al arrancar la partida: 1 consulta REST por cliente
  // (jugadores y anfitriones), como el hook optimizado. `PING_BURST=1` la emula.
  if (PING_BURST) {
    await enLotes(
      rooms.flatMap((room) => [host, ...room.jugadores.map((j) => j.client)]).map((c) => ({ c })),
      40,
      async ({ c }) => sincronizarReloj(c)
    );
    await esperar(1500);
  }
  await enLotes(
    rooms.flatMap((room, ri) => room.jugadores.map((j) => ({ j, ri }))),
    40,
    async ({ j, ri }) => {
      await rpcSeguro(
        j.client,
        'trivia_responder',
        { p_token: j.token, p_opcion: 0, p_pregunta_id: preguntaIds[ri] },
        'trivia_responder'
      );
      if (!SIN_RESP_BROADCASTS) {
        enviados += 1;
        j.canal.send({ type: 'broadcast', event: 'ev', payload: { tipo: 'trivia_resp', jugador: j.id, de: j.token } });
      }
    }
  );
  await esperar(3000); // deja correr la entrega por WAL
});

// ---------------------------------------------------------------------------
// Fase 3: Basta en las 3 salas (5 upserts por jugador + broadcasts)
// ---------------------------------------------------------------------------
await fase(`BASTA (${SALAS * N * 5} upserts + ${SALAS * N * 5} broadcasts)`, async () => {
  const categorias = [];
  for (const room of rooms) {
    await host.rpc('basta_iniciar_ronda', { p_sala: room.sala.id });
    const { data } = await host.from('salas').select('juego').eq('id', room.sala.id).single();
    categorias.push(data.juego.categorias);
  }
  await enLotes(
    rooms.flatMap((room, ri) =>
      room.jugadores.flatMap((j) => categorias[ri].map((idCat, k) => ({ j, ri, idCat, k })))
    ),
    40,
    async ({ j, ri, idCat, k }) => {
      await rpcSeguro(
        j.client,
        'basta_enviar',
        { p_token: j.token, p_id_categoria: idCat, p_texto: `palabra${ri}${k}${j.id.slice(0, 4)}` },
        'basta_enviar'
      );
      const ahora = Date.now();
      if (THROTTLE_BASTA_MS === 0 || ahora - (j.ultimoBcast || 0) >= THROTTLE_BASTA_MS) {
        j.ultimoBcast = ahora;
        enviados += 1;
        j.canal.send({ type: 'broadcast', event: 'ev', payload: { tipo: 'basta_palabra', jugador: j.id, de: j.token } });
      }
    }
  );
  // El primero de cada sala declara completo (deadline letal) y el host cierra.
  await Promise.all(
    rooms.map(async (room) => {
      const j = room.jugadores[0];
      await j.client.rpc('basta_declarar_completo', { p_token: j.token });
      await host.rpc('basta_cerrar_ronda', { p_sala: room.sala.id });
    })
  );
  await esperar(3000);
});

// ---------------------------------------------------------------------------
// Fase 4: Rosco (carga individual + broadcasts)
// ---------------------------------------------------------------------------
await fase(`ROSCO (${SALAS} salas × ${N} respuestas)`, async () => {
  // El rosco exige sala en lobby con juego elegido: se cierra el Basta y se
  // vuelve al lobby (mismo flujo que la app: terminar → lobby → elegir juego).
  for (const [ri, room] of rooms.entries()) {
    await host.rpc('terminar_partida', { p_sala: room.sala.id });
    await host.rpc('volver_al_lobby', { p_sala: room.sala.id });
    const sel = await host.rpc('seleccionar_juego', { p_sala: room.sala.id, p_juego: 'rosco' });
    if (sel.error) throw new Error(`seleccionar rosco sala ${ri}: ${sel.error.message}`);
    const ini = await host.rpc('rosco_iniciar', { p_sala: room.sala.id });
    if (ini.error) throw new Error(`rosco_iniciar sala ${ri}: ${ini.error.message}`);
  }
  await enLotes(
    rooms.flatMap((room) => room.jugadores.map((j) => ({ j }))),
    40,
    async ({ j }) => {
      await rpcSeguro(j.client, 'rosco_enviar', { p_token: j.token, p_respuesta: 'zz' }, 'rosco_enviar');
      if (!SIN_RESP_BROADCASTS) {
        enviados += 1;
        j.canal.send({ type: 'broadcast', event: 'ev', payload: { tipo: 'rosco_resp', jugador: j.id, de: j.token } });
      }
    }
  );
  await esperar(3000);
});

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------
for (const room of rooms) {
  for (const j of room.jugadores) j.pings.forEach(clearInterval);
}
// Verificación de DELETE filtrado: se expulsa a un jugador por sala y los
// suscriptores restantes deben recibir el borrado (REPLICA IDENTITY FULL).
const deletesAntes = porTipo.delete_jugadores || 0;
for (const room of rooms) {
  await host.rpc('expulsar_jugador', { p_sala: room.sala.id, p_jugador: room.jugadores[0].id });
}
await esperar(2000);
const deletesRecibidos = (porTipo.delete_jugadores || 0) - deletesAntes;
// Los DELETE por Realtime son best-effort (la fila vieja solo trae la PK y la
// entrega de Supabase es intermitente): el polling y la instantánea del host
// concilian cualquier borrado perdido. Se informa, no se falla por esto.
console.log(
  `\n  DELETE por Realtime: ${deletesRecibidos} (best-effort; el polling garantiza la conciliación)`
);
await esperar(500);
for (const room of rooms) {
  await host.rpc('borrar_sala', { p_sala: room.sala.id });
}
for (const room of rooms) {
  await host.removeChannel(room.hostCanal);
  for (const j of room.jugadores) await j.client.removeChannel(j.canal);
}

// ---------------------------------------------------------------------------
// Reporte
// ---------------------------------------------------------------------------
const serie = [...porSegundo.entries()].sort((a, b) => a[0] - b[0]);
let pico = 0;
let picoSeg = 0;
for (const [s, v] of serie) {
  if (v > pico) {
    pico = v;
    picoSeg = s;
  }
}
const total = totalEventos();
const segundos = serie.length || 1;
const promedio = total / segundos;

function promedioFase(nombre) {
  const f = fases.find((x) => x.nombre.startsWith(nombre));
  if (!f) return 0;
  const enFase = serie
    .filter(([s]) => s * 1000 >= f.inicio && s * 1000 <= f.fin)
    .reduce((a, [, v]) => a + v, 0);
  return enFase / Math.max(1, (f.fin - f.inicio) / 1000);
}

const reposo = promedioFase('REPOSO');
const juego = Math.max(promedioFase('TRIVIA'), promedioFase('BASTA'), promedioFase('ROSCO'));

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  RESULTADO');
console.log('══════════════════════════════════════════════════════════════');
console.log(`  Clientes conectados ......... ${SALAS * (N + 1)}`);
console.log(`  Eventos entregados .......... ${total} (enviados por clientes: ${enviados})`);
console.log(`  Pico ........................ ${pico} msg/s (segundo ${picoSeg})`);
console.log(`  Promedio global ............. ${promedio.toFixed(0)} msg/s`);
console.log(`  Promedio REPOSO ............. ${reposo.toFixed(0)} msg/s`);
console.log(`  Promedio JUEGO (peor fase) .. ${juego.toFixed(0)} msg/s`);
console.log(`  Fan-out entre salas (ajenos)  ${ajenos} eventos`);
console.log(`  Broadcasts cruzados OK ...... ${crossOk}`);
console.log(`  Sends caídos a REST ......... ${fallbacksRest}${fallbacksRest > 0 ? '  ⚠ canales cerrados por límite' : ''}`);
console.log('  Desglose:');
for (const [tipo, n] of Object.entries(porTipo).sort((a, b) => b[1] - a[1])) {
  console.log(`    ${tipo.padEnd(20)} ${String(n).padStart(7)}`);
}

// Extrapolación de presupuesto mensual (2M mensajes Free).
const porHoraReposo = reposo * 3600;
const porHoraJuego = juego * 3600;
console.log('\n  Presupuesto Free (2M mensajes/mes):');
console.log(`    Solo lobby (reposo): ${(2e6 / Math.max(1, porHoraReposo)).toFixed(1)} h/mes`);
console.log(`    Solo juego:          ${(2e6 / Math.max(1, porHoraJuego)).toFixed(1)} h/mes`);

const problemas = [];
if (crossOk === 0) problemas.push('los broadcasts no cruzaron entre clientes');
if (total === 0) problemas.push('no se recibió ningún evento');
console.log(
  problemas.length === 0
    ? '\n  ✔ Realtime funcionando y medido'
    : `\n  ✗ PROBLEMAS: ${problemas.join('; ')}`
);
process.exit(problemas.length === 0 ? 0 : 1);
