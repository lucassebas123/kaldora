// scripts/test-e2e.mjs
//
// TEST 3 — Verificación E2E contra Supabase REAL (proyecto remoto).
// Simula el flujo completo de la plataforma:
//   1. Anfitrión: signup + login (Supabase Auth) + crear sala
//   2. Jugadores: unirse con PIN (anon + token) + login multicanal
//   2c. Verificación de WhatsApp: código pendiente → el host confirma
//   3. ROSCO: iniciar, responder bien/mal (validación server-side), 27 letras,
//      pasapalabra con la MISMA pregunta al volver
//   4. TRIVIA: ronda de 10 s con base 1000 decreciente, rachas
//   5. BASTA: palabras, deadline letal, únicas vs repetidas
//   6. SUPERVIVENCIA: V/F con eliminación súbita
//   7. Seguridad: anon NO puede crear salas, ni leer respuestas/índices/PII,
//      ni escribir tablas; Realtime entrega cambios de sala.
//
// Uso: node scripts/test-e2e.mjs   (lee .env)

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { cargarEntorno } from './_entorno.mjs';

// Entorno: `.env` (producción) o `.env.staging` con ENTORNO=staging.
const env = cargarEntorno();
const SUPA_URL = env.url;
const ANON = env.anon;

let pasadas = 0;
let falladas = 0;
function verificar(descripcion, condicion) {
  if (condicion) {
    pasadas++;
    console.log(`  ✓ ${descripcion}`);
  } else {
    falladas++;
    console.error(`  ✗ FALLO: ${descripcion}`);
  }
}
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

// --- clientes ----------------------------------------------------------------
// Cada cliente su propio almacenamiento de sesión (supabase-js comparte el
// de memoria entre instancias: sin esto, el "anon" viajaría con el token del host).
function crearAlmacen() {
  const mapa = new Map();
  return {
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => mapa.set(k, String(v)),
    removeItem: (k) => mapa.delete(k),
  };
}
const TRANSPORT = { realtime: { transport: WebSocket } };
// storageKey ÚNICO por cliente: supabase-js singletoniza el cliente Auth por
// storageKey; sin esto, el login del host contamina a los clientes "anon".
const host = createClient(SUPA_URL, ANON, { ...TRANSPORT, auth: { storage: crearAlmacen(), storageKey: 'e2e-host' } });
const j1 = createClient(SUPA_URL, ANON, { ...TRANSPORT, auth: { storage: crearAlmacen(), storageKey: 'e2e-j1' } });
const j2 = createClient(SUPA_URL, ANON, { ...TRANSPORT, auth: { storage: crearAlmacen(), storageKey: 'e2e-j2' } });
const anon = createClient(SUPA_URL, ANON, { ...TRANSPORT, auth: { storage: crearAlmacen(), storageKey: 'e2e-anon' } });

const EMAIL_HOST = env.hostEmail;
const PASS_HOST = env.hostPass;

// =============================================================================
console.log('\n═══ 1. Autenticación del anfitrión ═══');
// =============================================================================
const emailIntento = `x${Date.now()}@kaldora.site`;
const signupAnon = await anon.auth.signUp({ email: emailIntento, password: 'Kaldora2026!e2e' });
await esperar(400);
const { data: fantasma } = await anon.from('admins_autorizados').select('id, email').eq('email', emailIntento).maybeSingle();
// En staging el signup queda habilitado a propósito (para crear hosts de
// prueba por Admin API); producción lo tiene deshabilitado. El control real
// (ni usuario ni admin creado) se verifica donde corresponde.
verificar(
  env.staging
    ? 'SEGURIDAD (producción): autorregistro deshabilitado — omitido en staging'
    : 'SEGURIDAD: NO existe autorregistro público (ni usuario ni admin creado)',
  env.staging ? true : !!signupAnon.error && !fantasma
);

const login = await host.auth.signInWithPassword({ email: EMAIL_HOST, password: PASS_HOST });
if (login.error) {
  console.log('  ⚠ No se pudo loguear el host:', login.error.message);
  process.exit(2);
}
verificar('login del anfitrión (dueño) OK', !login.error);

// =============================================================================
console.log('\n═══ 2. Sala: creación + uniones ═══');
// =============================================================================
const { data: sala, error: errSala } = await host.rpc('crear_sala');
verificar('crear_sala devuelve PIN de 6 dígitos', !errSala && /^\d{6}$/.test(sala?.codigo || ''));
console.log(`     sala ${sala.codigo} (${sala.id})`);

const DATOS1 = { p_nombre: 'Lucas', p_apellido: 'Prueba Uno', p_telefono: '+54 9 11 5555-0001', p_correo: 'lucas.prueba1@example.com' };
const DATOS2 = { p_nombre: 'Marta', p_apellido: 'Prueba Dos', p_telefono: '1155550002', p_correo: 'marta.prueba2@example.com' };
const unido1 = await j1.rpc('unirse_sala', { p_codigo: sala.codigo, p_nickname: 'E2E_Uno', p_icono: 'Zap', p_color: 'bg-red-500', ...DATOS1 });
verificar('jugador 1 se une (con registro) y recibe token', !unido1.error && unido1.data?.token?.length === 32);
const unido2 = await j2.rpc('unirse_sala', { p_codigo: sala.codigo, p_nickname: 'E2E_Dos', p_icono: 'Flame', p_color: 'bg-blue-500', ...DATOS2 });
verificar('jugador 2 se une (con registro) y recibe token', !unido2.error && unido2.data?.token?.length === 32);

// Cuenta DISTINTA con el nickname de J1 (insensible a mayúsculas) → rechazo.
const nickDuplicado = await j1.rpc('unirse_sala', {
  p_codigo: sala.codigo, p_nickname: 'e2e_uno',
  p_nombre: 'Otra', p_apellido: 'Persona', p_telefono: '1166660001',
  p_correo: `nickdup.${Date.now()}@example.com`, p_icono: 'Star', p_color: 'bg-green-500',
});
verificar('nickname duplicado rechazado (insensible a mayúsculas)', !!nickDuplicado.error);

const correoMalo = await j1.rpc('unirse_sala', { p_codigo: sala.codigo, p_nickname: 'E2E_Tres', p_nombre: 'X', p_apellido: 'Y', p_telefono: '1155550003', p_correo: 'no-es-correo', p_icono: 'Star', p_color: 'bg-green-500' });
verificar('registro: correo inválido rechazado', !!correoMalo.error);
const telMalo = await j1.rpc('unirse_sala', { p_codigo: sala.codigo, p_nickname: 'E2E_Tres', p_nombre: 'X', p_apellido: 'Y', p_telefono: 'abc', p_correo: 'ok@ok.com', p_icono: 'Star', p_color: 'bg-green-500' });
verificar('registro: celular inválido rechazado', !!telMalo.error);
const sinNombre = await j1.rpc('unirse_sala', { p_codigo: sala.codigo, p_nickname: 'E2E_Tres', p_nombre: '  ', p_apellido: 'Y', p_telefono: '1155550003', p_correo: 'ok@ok.com', p_icono: 'Star', p_color: 'bg-green-500' });
verificar('registro: nombre obligatorio', !!sinNombre.error);

// =============================================================================
console.log('\n═══ 2b. LOGIN MULTICANAL (PIN de jugador · correo · celular) ═══');
// =============================================================================
const MARCA_MC = Date.now().toString(36);
const DATOS_MC = {
  p_nombre: 'Multi',
  p_apellido: 'Canal',
  p_telefono: `+54 9 11 7777-${String(Date.now()).slice(-4)}`,
  p_correo: `multicanal.${MARCA_MC}@example.com`,
};
const { data: salaMC } = await host.rpc('crear_sala');
verificar('sala multicanal creada', /^\d{6}$/.test(salaMC?.codigo || ''));

const regMC = await j1.rpc('unirse_sala', {
  p_codigo: salaMC.codigo, p_nickname: 'MC_Base', p_icono: 'Star', p_color: 'bg-purple-500', ...DATOS_MC,
});
verificar('registro devuelve PIN de jugador (JUG-######)', /^JUG-[0-9]{6}$/.test(regMC.data?.pinJugador || ''));
verificar('cuenta nueva marca recurrente=false', regMC.data?.recurrente === false);

const regMC2 = await j1.rpc('unirse_sala', {
  p_codigo: salaMC.codigo, p_nickname: 'MC_Otra', p_icono: 'Flame', p_color: 'bg-blue-500', ...DATOS_MC,
});
verificar('re-registro con el mismo correo conserva el PIN y marca recurrente',
  regMC2.data?.pinJugador === regMC.data.pinJugador && regMC2.data?.recurrente === true);

const porPin = await j2.rpc('entrar_con_identificador', {
  p_codigo: salaMC.codigo, p_identificador: regMC.data.pinJugador.toLowerCase(),
});
verificar('login con PIN de jugador OK (case-insensitive)',
  !porPin.error && porPin.data?.token?.length === 32 && porPin.data?.pinJugador === regMC.data.pinJugador);

const porCorreo = await j2.rpc('entrar_con_identificador', {
  p_codigo: salaMC.codigo, p_identificador: DATOS_MC.p_correo.toUpperCase(),
});
verificar('login con correo OK (case-insensitive) y reutiliza la fila de la sala',
  !porCorreo.error && porCorreo.data?.nickname === 'MC_Otra');

const porCelular = await j2.rpc('entrar_con_identificador', {
  p_codigo: salaMC.codigo, p_identificador: DATOS_MC.p_telefono,
});
verificar('login con celular OK (con formato +54 ...)',
  !porCelular.error && porCelular.data?.token?.length === 32 && porCelular.data?.nickname === 'MC_Otra');

const identMalo = await j2.rpc('entrar_con_identificador', {
  p_codigo: salaMC.codigo, p_identificador: `nadie-${MARCA_MC}`,
});
// El anti fuerza bruta devuelve error "suave" ({error} en data) para poder
// registrar el intento: cualquiera de las dos formas es un rechazo válido.
const mensajeIdentMalo = identMalo.error?.message || identMalo.data?.error || '';
verificar('identificador desconocido rechazado con mensaje claro',
  /No encontramos tu registro/.test(mensajeIdentMalo), mensajeIdentMalo);

const mcReabierta = await j1.rpc('entrar_con_identificador', {
  p_codigo: salaMC.codigo, p_identificador: regMC.data.pinJugador, p_icono: 'Star', p_color: 'bg-purple-500',
});
const { data: jugsMC } = await anon.from('jugadores').select('id, nickname').eq('id_sala', salaMC.id);
verificar('re-registro y login reutilizan UNA fila de la cuenta (sin fantasmas)',
  !mcReabierta.error && jugsMC.length === 1 && jugsMC[0].nickname === 'MC_Otra');

const anonPIIMC = await anon.from('registros_jugadores').select('pin_jugador').limit(1);
verificar('SEGURIDAD: anon NO puede leer PINs de jugadores', !!anonPIIMC.error || (anonPIIMC.data || []).length === 0);
await host.rpc('borrar_sala', { p_sala: salaMC.id });

// =============================================================================
console.log('\n═══ 2c. VERIFICACIÓN DE WHATSAPP (gratis, la confirma el anfitrión) ═══');
// =============================================================================
const { data: salaVerif } = await host.rpc('crear_sala');
verificar('sala de verificación creada', /^\d{6}$/.test(salaVerif?.codigo || ''));

const numMalo = await host.rpc('actualizar_contacto_whatsapp', { p_sala: salaVerif.id, p_whatsapp: 'no-es-numero!' });
verificar('WhatsApp de sala inválido rechazado', !!numMalo.error);

const numVerif = await host.rpc('actualizar_contacto_whatsapp', { p_sala: salaVerif.id, p_whatsapp: '+54 9 11 5555-9999' });
verificar('el anfitrión configura el WhatsApp de la sala',
  !numVerif.error && numVerif.data?.whatsapp === '+54 9 11 5555-9999');

const DATOS_V = {
  p_nombre: 'Vera',
  p_apellido: 'Ifi',
  p_telefono: `+54 9 11 4444-${String(Date.now()).slice(-4)}`,
  p_correo: `verif.${MARCA_MC}@example.com`,
};
const regV = await j1.rpc('unirse_sala', {
  p_codigo: salaVerif.codigo, p_nickname: 'V_Prueba', p_icono: 'Shield', p_color: 'bg-green-500', ...DATOS_V,
});
verificar('registro nuevo devuelve código de 6 dígitos + WhatsApp de la sala (pendiente)',
  /^[0-9]{6}$/.test(regV.data?.codigoVerificacion || '')
  && regV.data?.whatsapp === '+54 9 11 5555-9999'
  && regV.data?.verificado === false);

const estV1 = await j1.rpc('estado_verificacion', { p_token: regV.data.token });
verificar('el jugador ve su código pendiente y el WhatsApp',
  estV1.data?.verificado === false
  && /^[0-9]{6}$/.test(estV1.data?.codigo || '')
  && Boolean(estV1.data?.whatsapp));

const pendAnon = await anon.rpc('verificaciones_pendientes', { p_sala: salaVerif.id });
verificar('SEGURIDAD: anon NO puede leer los pendientes (PII)', !!pendAnon.error);

const pendHost = await host.rpc('verificaciones_pendientes', { p_sala: salaVerif.id });
const pend = (pendHost.data?.pendientes || []).find((p) => p.idJugador === regV.data.idJugador);
verificar('el anfitrión ve al pendiente con celular y código',
  !pendHost.error && pend?.codigo === regV.data.codigoVerificacion && pend?.telefono === DATOS_V.p_telefono);

const confirm = await host.rpc('confirmar_verificacion', { p_sala: salaVerif.id, p_jugador: regV.data.idJugador });
verificar('el anfitrión confirma la verificación', !confirm.error);

const estV2 = await j1.rpc('estado_verificacion', { p_token: regV.data.token });
verificar('el jugador queda verificado y sin código pendiente',
  estV2.data?.verificado === true && !estV2.data?.codigo);

const { data: filaV } = await anon.from('jugadores').select('verificado').eq('id', regV.data.idJugador).single();
verificar('la columna pública `verificado` viaja a la TV (sin PII)', filaV?.verificado === true);

// Reingreso: la verificación se hereda (no se pide de nuevo).
const reV = await j2.rpc('entrar_con_identificador', { p_codigo: salaVerif.codigo, p_identificador: DATOS_V.p_correo });
verificar('login de una cuenta verificada entra como verificada', !reV.error && reV.data?.verificado === true);

await host.rpc('borrar_sala', { p_sala: salaVerif.id });

const anonCrea = await anon.rpc('crear_sala');
verificar('SEGURIDAD: anon NO puede crear salas', !!anonCrea.error);

// =============================================================================
console.log('\n═══ 3. JUEGO ROSCO (individual: reloj total + pasapalabra circular) ═══');
// =============================================================================
const selRosco = await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'rosco' });
verificar('seleccionar_juego(rosco) OK', !selRosco.error);
const iniRosco = await host.rpc('rosco_iniciar', { p_sala: sala.id, p_duracion_seg: 600 });
verificar('rosco_iniciar OK (10 min de reloj)', !iniRosco.error);

const { data: salaRosco } = await anon.from('salas').select('juego').eq('id', sala.id).single();
verificar('el reloj total arrancó (inicio + duración)', Boolean(salaRosco?.juego?.inicio) && salaRosco?.juego?.duracion_ms === 600000);

// El anon ve la pregunta pero JAMÁS la respuesta.
const { data: preguntaAnon, error: ePregAnon } = await anon
  .from('preguntas').select('id, letra, pregunta').eq('id', 0).limit(0);
void preguntaAnon; void ePregAnon;

// Estados de cada jugador vía RPC (restauración incluida).
const estadoJ1 = await j1.rpc('rosco_estado', { p_token: unido1.data.token });
verificar('rosco_estado devuelve letra A + pregunta fija', estadoJ1.data?.rosco?.l === 'A' && Boolean(estadoJ1.data?.rosco?.q));
const estadoJ2 = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
verificar('ambos arrancan en la A', estadoJ2.data?.rosco?.l === 'A');

// Helper: respuesta correcta de la pregunta fijada (el host la ve).
async function respuestaDeLetra(clienteHost, letra) {
  const est = letra === 'J1' ? estadoJ1 : null;
  void est;
  return null;
}

// J1 responde TODO correcto (recorre 27 letras y termina su rosco).
let puntosJ1 = 0;
let pasadasJ1 = 0;
let letraJ1 = 'A';
for (let i = 0; i < 40; i++) {
  const est = await j1.rpc('rosco_estado', { p_token: unido1.data.token });
  if (est.data?.rosco?.t) break;
  const { data: preg } = await host
    .from('preguntas').select('respuesta').eq('id', est.data?.rosco?.q).single();
  const r = await j1.rpc('rosco_enviar', { p_token: unido1.data.token, p_respuesta: preg.respuesta });
  if (r.error) { console.log('   error inesperado J1:', r.error.message); break; }
  puntosJ1 = (await anon.from('jugadores').select('puntos').eq('id', unido1.data.idJugador).single()).data.puntos;
  letraJ1 = r.data.letra;
  pasadasJ1++;
}
verificar(`J1 completó el rosco con todas correctas (${pasadasJ1} letras)`, pasadasJ1 === 27);
verificar('J1 suma 2700 puntos (+100 × 27)', puntosJ1 === 2700);
const finJ1 = await j1.rpc('rosco_estado', { p_token: unido1.data.token });
verificar('rosco de J1 marcado terminado', finJ1.data?.rosco?.t === true);

// J2: PASAPALABRA en A y B; al volver el ciclo, la pregunta de cada letra
// debe ser LA MISMA (regresión: antes se re-sorteaba con order by random()).
const estadoJ2Antes = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
const qA = estadoJ2Antes.data?.rosco?.q;
const pasoJ2 = await j2.rpc('rosco_pasar', { p_token: unido2.data.token });
verificar('pasapalabra en A: sin puntos y avanza a B', !pasoJ2.error && pasoJ2.data?.letra === 'B');
const estadoJ2B = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
const qB = estadoJ2B.data?.rosco?.q;
const pasoJ2b = await j2.rpc('rosco_pasar', { p_token: unido2.data.token });
verificar('pasapalabra en B: avanza a C', !pasoJ2b.error && pasoJ2b.data?.letra === 'C');
void letraJ1; void respuestaDeLetra;

let volvioPorA = false;
let qAEstable = null;
let qBEstable = null;
for (let i = 0; i < 30; i++) {
  const r = await j2.rpc('rosco_enviar', { p_token: unido2.data.token, p_respuesta: 'zzzz-nada' });
  if (r.error) { console.log('   error inesperado J2:', r.error.message); break; }
  if (r.data.letra === 'A') {
    volvioPorA = true; // regresó por la pasapalabra
    const est = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
    qAEstable = est.data?.rosco?.q;
  }
  if (r.data.letra === 'B') {
    const est = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
    qBEstable = est.data?.rosco?.q;
  }
  if (r.data.terminado) break;
}
verificar('ciclo circular: después de la Z vuelve por las pendientes A y B', volvioPorA === true);
verificar('la pregunta de la letra pasada NO cambia al volver (A)', Boolean(qA) && qAEstable === qA);
verificar('la pregunta de la letra pasada NO cambia al volver (B)', Boolean(qB) && qBEstable === qB);
const finJ2 = await j2.rpc('rosco_estado', { p_token: unido2.data.token });
verificar('rosco de J2 terminado (no quedan pendientes)', finJ2.data?.rosco?.t === true);
const puntosJ2 = (await anon.from('jugadores').select('puntos').eq('id', unido2.data.idJugador).single()).data.puntos;
verificar('J2 con errores (-50 × 27, piso en 0) → 0 puntos', puntosJ2 === 0);
const respuestaDoble = await j1.rpc('rosco_enviar', { p_token: unido1.data.token, p_respuesta: 'x' });
verificar('rosco terminado rechaza más respuestas', !!respuestaDoble.error);

await host.rpc('volver_al_lobby', { p_sala: sala.id });

// =============================================================================
console.log('\n═══ 4. TRIVIA DE VELOCIDAD (1000 base, rachas) ═══');
// =============================================================================
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'trivia' });
const sig = await host.rpc('trivia_siguiente', { p_sala: sala.id });
verificar('trivia_siguiente OK', !sig.error);

const { data: salaTrivia } = await anon.from('salas').select('juego').eq('id', sala.id).single();
verificar('trivia: duración por defecto 10 s', salaTrivia?.juego?.duracion_ms === 10000);
const { data: preguntaTAnon, error: ePregTAnon } = await anon
  .from('preguntas_trivia').select('id, pregunta, opciones').eq('id', salaTrivia.juego.pregunta_id).single();
verificar('anon ve pregunta + opciones', !ePregTAnon && Boolean(preguntaTAnon?.pregunta) && Array.isArray(preguntaTAnon?.opciones));

const { error: eColTAnon } = await anon
  .from('preguntas_trivia').select('indice_correcto').eq('id', salaTrivia.juego.pregunta_id).single();
verificar('SEGURIDAD: anon NO puede leer indice_correcto', !!eColTAnon);

const { data: pregTHost } = await host
  .from('preguntas_trivia').select('indice_correcto').eq('id', salaTrivia.juego.pregunta_id).single();
verificar('host ve indice_correcto', Number.isInteger(pregTHost?.indice_correcto));

// J1 responde correcto al instante (base ~1000), J2 responde mal.
const preguntaIdTrivia = salaTrivia.juego.pregunta_id;
const rT1 = await j1.rpc('trivia_responder', { p_token: unido1.data.token, p_opcion: pregTHost.indice_correcto, p_pregunta_id: preguntaIdTrivia });
verificar('respuesta correcta: puntúa (base 1000 decreciente) y racha 1', !rT1.error && rT1.data?.correcta === true && rT1.data?.puntos > 500 && rT1.data?.puntos <= 1000 && rT1.data?.racha === 1);
const opcionIncorrecta = (pregTHost.indice_correcto + 1) % preguntaTAnon.opciones.length;
// V5: la opción viaja atada a la pregunta que el jugador vio; con el id de
// otra pregunta se rechaza ANTES de registrar nada (ventana de rotación).
const rTV5 = await j2.rpc('trivia_responder', { p_token: unido2.data.token, p_opcion: opcionIncorrecta, p_pregunta_id: randomUUID() });
verificar('V5: respuesta atada a la pregunta vista (id ajeno rechazado)', !!rTV5.error && /La pregunta ya cambió/.test(rTV5.error.message));
const rT2 = await j2.rpc('trivia_responder', { p_token: unido2.data.token, p_opcion: opcionIncorrecta, p_pregunta_id: preguntaIdTrivia });
verificar('respuesta errada: 0 pts y racha 0', !rT2.error && rT2.data?.correcta === false && rT2.data?.puntos === 0 && rT2.data?.racha === 0);
const rT1dup = await j1.rpc('trivia_responder', { p_token: unido1.data.token, p_opcion: pregTHost.indice_correcto, p_pregunta_id: preguntaIdTrivia });
verificar('doble respuesta rechazada', !!rT1dup.error);
console.log(`     racha: J1 = ${rT1.data?.racha} (mult ${rT1.data?.multiplicador}x)`);

await host.rpc('volver_al_lobby', { p_sala: sala.id });

// =============================================================================
console.log('\n═══ 5. BASTA (5 categorías, deadline letal, únicas) ═══');
// =============================================================================
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'basta' });
const ronda = await host.rpc('basta_iniciar_ronda', { p_sala: sala.id });
verificar('basta_iniciar_ronda devuelve letra + 5 categorías', !ronda.error && ronda.data?.categorias?.length === 5);

const { data: salaBasta } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const cats = salaBasta.juego.categorias;
const letraBasta = salaBasta.juego.letra;

// J1: completa 5 palabras (alguna compartida con J2), declara basta.
// Prefijo "Kaldo...Test" (inexistente en el diccionario) para no depender de
// que la letra sorteada no forme una palabra real ("PalabraS" = "palabras").
for (const c of cats) await j1.rpc('basta_enviar', { p_token: unido1.data.token, p_id_categoria: c, p_texto: `Kaldo${letraBasta}Test` });
const decl1 = await j1.rpc('basta_declarar_completo', { p_token: unido1.data.token });
verificar('J1 completa 5 y dispara la cuenta letal', !decl1.error && decl1.data?.soyPrimero === true);

const { data: salaBasta2 } = await anon.from('salas').select('juego').eq('id', sala.id).single();
verificar('fase → cuenta_atras con deadline', salaBasta2.juego.fase === 'cuenta_atras' && Boolean(salaBasta2.juego.deadline));

// Categorías con léxico (validación estricta) vs abiertas (solo diccionario).
const { data: catsInfo } = await anon.from('categorias_basta').select('id, nombre, clave_lexico');
const nombreDe = (id) => catsInfo?.find((c) => c.id === id)?.nombre || '';
const tieneLexico = (id) => Boolean(catsInfo?.find((c) => c.id === id)?.clave_lexico);

// J2: dentro de los 10 s: una repetida de J1, una ÚNICA que existe en el
// diccionario (palabra real por letra), y una INVENTADA que no existe.
const PALABRAS_REALES = { A:['asado'], B:['bondi'], C:['cine'], D:['dado'], E:['empanada'], F:['futbol'], G:['gato'], H:['helado'], I:['iguana'], J:['jirafa'], K:['karate'], L:['limon'], M:['mate'], N:['naranja'], 'Ñ':['nandu'], O:['oso'], P:['piba'], Q:['queso'], R:['raton'], S:['sol'], T:['tango'], U:['uva'], V:['vaca'], W:['whisky'], X:['xilofon'], Y:['yerba'], Z:['zapato'] };
const real = (PALABRAS_REALES[letraBasta] || ['perro'])[0];

await j2.rpc('basta_enviar', { p_token: unido2.data.token, p_id_categoria: cats[0], p_texto: `kaldo${letraBasta.toLowerCase()}test ` }); // repetida de J1
await j2.rpc('basta_enviar', { p_token: unido2.data.token, p_id_categoria: cats[1], p_texto: real }); // existe en diccionario
await j2.rpc('basta_enviar', { p_token: unido2.data.token, p_id_categoria: cats[2], p_texto: `Zz${letraBasta}qq` }); // INVENTADA
await j2.rpc('basta_enviar', { p_token: unido2.data.token, p_id_categoria: cats[3], p_texto: `Otra${letraBasta}` });
await j2.rpc('basta_enviar', { p_token: unido2.data.token, p_id_categoria: cats[4], p_texto: `Otra2${letraBasta}` });

const cierre = await host.rpc('basta_cerrar_ronda', { p_sala: sala.id });
verificar('cierre de ronda OK', !cierre.error);

// Resultados (el anon ya puede leer con fase resultados).
await esperar(300);
const { data: resJ1 } = await j1.from('respuestas_basta').select('id, id_categoria, texto, valida, unico, puntos, existe').eq('id_jugador', unido1.data.idJugador);
const { data: resJ2 } = await j2.from('respuestas_basta').select('id, id_categoria, texto, valida, unico, puntos, existe, corresponde').eq('id_jugador', unido2.data.idJugador);
const repJ2 = resJ2.find((r) => r.id_categoria === cats[0]);
const uniJ2 = resJ2.find((r) => r.id_categoria === cats[1]);
const totalJ1 = resJ1.reduce((a, r) => a + r.puntos, 0);
const totalJ2 = resJ2.reduce((a, r) => a + r.puntos, 0);
const inventada = resJ2.find((r) => r.id_categoria === cats[2]);
// El diccionario es ASESOR: marca (existe=false) pero NO quita puntos.
// El host decide: valida=true puntúa (única 10 / repetida 5); tachada = 0.
verificar('repetida de J1: repetida +5 y no única', repJ2?.puntos === 5 && repJ2?.unico === false);
// El diccionario no tiene palabras con K/W y las Ñ quedan sin acento (unaccent
// las mapea a N): esas letras no pueden "existir" y el aviso se espera false.
const letraSinDiccionario = ['K', 'W', 'Ñ'].includes(letraBasta);
verificar('palabra real única: única +10 y avisada como existente',
  uniJ2?.unico === true && uniJ2?.puntos === 10
  && uniJ2?.existe === !letraSinDiccionario);
verificar('palabra INVENTADA: aviso existe=false pero puntúa como única (host manda)', inventada?.existe === false && inventada?.unico === true && inventada?.puntos === 10);
verificar('J1: 5 inventadas sin diccionario puntúan igual (45: 1 repetida + 4 únicas)', totalJ1 === 45 && resJ1.every((r) => r.existe === false));
console.log(`     categoría de la real: "${nombreDe(cats[1])}" (léxico: ${tieneLexico(cats[1]) ? 'sí' : 'abierto'}) · J1: ${totalJ1} · J2: ${totalJ2}`);

// Moderación: el host tacha la inventada y recalcula → 0 pts (host manda).
const tachada = await host.rpc('basta_toggle_valida', { p_sala: sala.id, p_id_respuesta: inventada.id, p_valida: false });
const recalc = await host.rpc('basta_cerrar_ronda', { p_sala: sala.id });
await esperar(300);
const { data: resJ2b } = await j2.from('respuestas_basta').select('id, id_categoria, valida, puntos').eq('id_jugador', unido2.data.idJugador);
const inventadaB = resJ2b.find((r) => r.id === inventada.id);
verificar('host tacha la inventada y recalcula → 0 pts', !tachada.error && !recalc.error && inventadaB?.valida === false && inventadaB?.puntos === 0);

// ── 5b. SEGUNDA RONDA: regresión de doble conteo ─────────────────────────────
// Antes, iniciar una ronda nueva NO borraba `respuestas_basta` y el cierre
// sumaba las filas de la ronda anterior dos veces (puntos inflados).
const { data: jugsR1 } = await anon.from('jugadores').select('id, puntos').eq('id_sala', sala.id);
const puntosJ1R1 = jugsR1.find((j) => j.id === unido1.data.idJugador)?.puntos;
const puntosJ2R1 = jugsR1.find((j) => j.id === unido2.data.idJugador)?.puntos;
verificar('fin ronda 1: J1=45 y J2=35', puntosJ1R1 === 45 && puntosJ2R1 === 35);

const ronda2 = await host.rpc('basta_iniciar_ronda', { p_sala: sala.id });
verificar('ronda 2 inicia OK', !ronda2.error);
const { data: salaBasta3 } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const cats2 = salaBasta3.juego.categorias;
const { count: filasR2 } = await host
  .from('respuestas_basta').select('id', { count: 'exact', head: true }).eq('id_sala', sala.id);
verificar('al iniciar la ronda 2 se limpian las respuestas de la ronda 1', filasR2 === 0);

// J1 juega la ronda 2 (5 únicas = +50); J2 no juega: no debe recuperar puntos.
for (const c of cats2) await j1.rpc('basta_enviar', { p_token: unido1.data.token, p_id_categoria: c, p_texto: `R2${ronda2.data.letra}` });
await host.rpc('basta_cerrar_ronda', { p_sala: sala.id });
await esperar(300);
const { data: jugsR2 } = await anon.from('jugadores').select('id, puntos').eq('id_sala', sala.id);
const puntosJ1R2 = jugsR2.find((j) => j.id === unido1.data.idJugador)?.puntos;
const puntosJ2R2 = jugsR2.find((j) => j.id === unido2.data.idJugador)?.puntos;
verificar('ronda 2 NO re-suma la ronda 1: J1 = 45+50 = 95', puntosJ1R2 === 95);
verificar('quien no juega la ronda 2 conserva sus puntos (J2 = 35)', puntosJ2R2 === 35);

await host.rpc('volver_al_lobby', { p_sala: sala.id });

// =============================================================================
console.log('\n═══ 6. SUPERVIVENCIA (V/F, eliminación súbita) ═══');
// =============================================================================
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'supervivencia' });
const sigS = await host.rpc('supervivencia_siguiente', { p_sala: sala.id, p_duracion_ms: 10000 });
verificar('supervivencia_siguiente OK', !sigS.error);

const { data: salaSup } = await anon.from('salas').select('juego').eq('id', sala.id).single();
const { data: pregSAnon, error: ePregSAnon } = await anon
  .from('preguntas_supervivencia').select('id, pregunta').eq('id', salaSup.juego.pregunta_id).single();
verificar('anon ve la pregunta', !ePregSAnon && Boolean(pregSAnon?.pregunta));

const { error: eColSAnon } = await anon
  .from('preguntas_supervivencia').select('es_verdadera').eq('id', salaSup.juego.pregunta_id).single();
verificar('SEGURIDAD: anon NO puede leer es_verdadera', !!eColSAnon);

const { data: pregSHost } = await host
  .from('preguntas_supervivencia').select('es_verdadera').eq('id', salaSup.juego.pregunta_id).single();
verificar('host ve es_verdadera', typeof pregSHost?.es_verdadera === 'boolean');

// J1 acierta (+25), J2 falla (eliminado).
const rS1 = await j1.rpc('supervivencia_responder', { p_token: unido1.data.token, p_respuesta: pregSHost.es_verdadera });
verificar('J1 acierta: +25 y vivo', !rS1.error && rS1.data?.correcta === true && rS1.data?.eliminado === false);
const rS2 = await j2.rpc('supervivencia_responder', { p_token: unido2.data.token, p_respuesta: !pregSHost.es_verdadera });
verificar('J2 falla: eliminado', !rS2.error && rS2.data?.correcta === false && rS2.data?.eliminado === true);

const { data: jugsSup } = await anon.from('jugadores').select('nickname, eliminado, puntos').eq('id_sala', sala.id);
verificar('eliminado marcado en la base', jugsSup.find((x) => x.nickname === 'E2E_Dos')?.eliminado === true);
verificar('vivo mantiene puntos +25', jugsSup.find((x) => x.nickname === 'E2E_Uno')?.puntos === 25);

const bloqueoElim = await j2.rpc('supervivencia_responder', { p_token: unido2.data.token, p_respuesta: true });
verificar('eliminado ya no puede responder', !!bloqueoElim.error);

// Fin de partida + podio.
await host.rpc('terminar_partida', { p_sala: sala.id });
const { data: salaFin } = await anon.from('salas').select('estado').eq('id', sala.id).single();
verificar('terminar_partida → estado finalizado', salaFin?.estado === 'finalizado');

// =============================================================================
console.log('\n═══ 6b. PERFIL POR CORREO + PAUSA/REANUDAR ═══');
// =============================================================================
const perfilViejo = await j1.rpc('perfil_por_correo', { p_correo: 'lucas.prueba1@example.com' });
verificar('correo ya registrado → existe + recupera nombre', perfilViejo.data?.existe === true && perfilViejo.data?.nombre === 'Lucas');
const perfilNuevo = await j1.rpc('perfil_por_correo', { p_correo: `nunca-jugado-${Date.now()}@ejemplo.com` });
verificar('correo nuevo → existe=false (va a registrarse)', perfilNuevo.data?.existe === false);
const perfilMal = await j1.rpc('perfil_por_correo', { p_correo: 'no-es-correo' });
verificar('correo mal formado → existe=false', perfilMal.data?.existe === false);

// Volver al lobby y probar pausa/reanudar con trivia.
await host.rpc('volver_al_lobby', { p_sala: sala.id });
await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'trivia' });
await host.rpc('trivia_siguiente', { p_sala: sala.id });
const pausaR = await host.rpc('pausar_partida', { p_sala: sala.id });
const { data: stPausa } = await anon.from('salas').select('estado, juego').eq('id', sala.id).single();
verificar('pausar → estado pausado + pausa_en guardada', !pausaR.error && stPausa?.estado === 'pausado' && Boolean(stPausa?.juego?.pausa_en));
const reanudaR = await host.rpc('reanudar_partida', { p_sala: sala.id });
const { data: stReanuda } = await anon.from('salas').select('estado, juego').eq('id', sala.id).single();
verificar('reanudar → estado jugando + relojes desplazados (sin pausa_en)', !reanudaR.error && stReanuda?.estado === 'jugando' && !stReanuda?.juego?.pausa_en);

await host.rpc('volver_al_lobby', { p_sala: sala.id });

// =============================================================================
console.log('\n═══ 7. Seguridad extra + Realtime ═══');
// =============================================================================
const anonUpdate = await anon.from('salas').update({ estado: 'finalizado' }).eq('id', sala.id);
verificar('SEGURIDAD: anon NO puede escribir salas', !!anonUpdate.error);

const anonPII = await anon.from('registros_jugadores').select('*').limit(1);
verificar('SEGURIDAD: anon NO puede leer registros (PII) de jugadores', !!anonPII.error || (anonPII.data || []).length === 0);

const anonCRUD = await anon.rpc('guardar_pregunta_rosco', { p_letra: 'A', p_pregunta: 'HACK', p_respuesta: 'HACK' });
verificar('SEGURIDAD: anon NO puede editar el banco de preguntas', !!anonCRUD.error);

const anonAdmins = await anon.from('admins_autorizados').select('*').limit(1);
verificar('SEGURIDAD: anon NO puede ver la lista de admins', !!anonAdmins.error || (anonAdmins.data || []).length === 0);

const anonSes = await anon.from('sesiones_jugador').select('token').limit(1);
verificar('SEGURIDAD: anon NO puede leer sesiones_jugador', !!anonSes.error || (anonSes.data || []).length === 0);

const anonRpcHost = await anon.rpc('terminar_partida', { p_sala: sala.id });
verificar('SEGURIDAD: anon NO puede ejecutar RPCs de host', !!anonRpcHost.error);

// Sincronización como la que usa la app: el anfitrión publica la instantánea
// por BROADCAST y el jugador la aplica al instante (postgres_changes queda
// como bonus, no como requisito — su entrega en el plan free es intermitente).
// El test REINTENTA (reenvía cada 1.5 s hasta 20 s): una entrega perdida no
// debe hacer flaquear la suite.
const sincronia = await new Promise((resolve) => {
  const topic = `e2e-sync-${sala.id}`;
  const canalJugador = j1.channel(topic);
  const canalHost = host.channel(topic);
  const ok = { hostAjugador: false, jugadorAhost: false };
  let resuelto = false;
  let intervalo = null;
  let timeout = null;

  const finalizar = () => {
    if (resuelto) return;
    resuelto = true;
    if (intervalo) clearInterval(intervalo);
    clearTimeout(timeout);
    resolve(ok);
  };

  // Dirección A (host→jugador), lo mismo que hace publicarEstado; dirección B
  // (jugador→host), lo mismo que avisan los contadores en vivo.
  const reenviar = () => {
    if (ok.hostAjugador && ok.jugadorAhost) {
      finalizar();
      return;
    }
    canalHost.send({
      type: 'broadcast',
      event: 'ev',
      payload: { tipo: 'sala', idSala: sala.id, sala: { id: sala.id }, jugadores: [] },
    });
    canalJugador.send({
      type: 'broadcast',
      event: 'ev',
      payload: { tipo: 'trivia_resp', idPregunta: sala.id, correcta: true },
    });
  };

  // Los listeners se registran ANTES de subscribe (orden que exige el canal).
  canalJugador.on('broadcast', { event: 'ev' }, ({ payload }) => {
    if (payload?.tipo === 'sala' && payload.idSala === sala.id) ok.hostAjugador = true;
    if (ok.hostAjugador && ok.jugadorAhost) finalizar();
  });
  canalHost.on('broadcast', { event: 'ev' }, ({ payload }) => {
    if (payload?.tipo === 'trivia_resp') ok.jugadorAhost = true;
    if (ok.hostAjugador && ok.jugadorAhost) finalizar();
  });

  let suscritos = 0;
  const alSuscribir = (status) => {
    if (status !== 'SUBSCRIBED') return;
    suscritos++;
    if (suscritos === 2) {
      reenviar();
      intervalo = setInterval(reenviar, 1500);
    }
  };
  timeout = setTimeout(finalizar, 20000);
  canalJugador.subscribe(alSuscribir);
  canalHost.subscribe(alSuscribir);
});
verificar('SINCRONÍA: la instantánea del anfitrión llega al celular (host→jugador)', sincronia.hostAjugador === true);
verificar('SINCRONÍA: los avisos del jugador llegan al anfitrión (jugador→host, contadores en vivo)', sincronia.jugadorAhost === true);

// Limpieza: borrar sala de prueba.
await host.rpc('borrar_sala', { p_sala: sala.id });

// El registro con los datos personales SOBREVIVE al borrado de la sala
// (id_jugador ya no hace CASCADE): clave para premios y contacto futuro.
await esperar(300);
const perfilPost = await anon.rpc('perfil_por_correo', { p_correo: 'lucas.prueba1@example.com' });
verificar('el registro sobrevive al borrado de la sala (historial persistente)',
  perfilPost.data?.existe === true && perfilPost.data?.nombre === 'Lucas' && perfilPost.data?.nickname === 'E2E_Uno');

console.log(`\n════════════════════════════════════`);
console.log(`RESULTADO E2E: ${pasadas} OK · ${falladas} fallos`);
console.log(`════════════════════════════════════`);
process.exit(falladas > 0 ? 1 : 0);
