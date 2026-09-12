// scripts/test-seguridad.mjs
//
// TEST DE SEGURIDAD — verifica contra una base REAL que:
//   1. anon no puede leer la columna sensible de `salas` (id_anfitrion).
//   2. `perfil_por_correo` ya no devuelve PII (apellido/teléfono).
//   3. El rate limit corta la fuerza bruta de identificadores.
//   4. Las entradas de juego están acotadas (opción de trivia, palabra de basta).
//   5. anon sigue SIN poder crear salas, escribir tablas ni leer respuestas.
//
// Uso: ENTORNO=staging node scripts/test-seguridad.mjs
// Limpia la tabla de intentos con service_role si está disponible.

import { cargarEntorno, cliente, datosJugador, servicioDeCli } from './_entorno.mjs';

const env = cargarEntorno();
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
console.log(`  KALDORA — TEST DE SEGURIDAD (entorno: ${env.archivo})`);
console.log('══════════════════════════════════════════════════════════════');

// Limpieza previa de intentos (service_role del .env.staging o vía CLI).
let service = env.service;
if (!service) {
  try {
    service = servicioDeCli();
  } catch {
    /* sin service_role: el test corre igual, pero no limpia */
  }
}
const admin = service ? cliente(env.url, service, `seg-admin-${MARCA}`) : null;
if (admin) await admin.from('intentos_acceso').delete().gte('id', 0);

const host = cliente(env.url, env.anon, `seg-host-${MARCA}`);
const login = await host.auth.signInWithPassword({ email: env.hostEmail, password: env.hostPass });
if (login.error) {
  console.error('✗ Login del host falló:', login.error.message);
  process.exit(2);
}
const { data: sala } = await host.rpc('crear_sala');

const anon = cliente(env.url, env.anon, `seg-anon-${MARCA}`);
const p1 = cliente(env.url, env.anon, `seg-p1-${MARCA}`);
const unido = await p1.rpc('unirse_sala', {
  p_codigo: sala.codigo,
  p_nickname: `Seg${MARCA}`.slice(0, 20),
  p_icono: 'Star',
  p_color: 'bg-purple-500',
  ...datosJugador(env, MARCA, 1),
});
if (unido.error) {
  console.error('✗ unirse_sala:', unido.error.message);
  process.exit(2);
}

console.log('\n═══ 1. Columnas y permisos de anon ═══');
{
  const publicas = await anon
    .from('salas')
    .select('id, codigo, estado, juego_actual')
    .eq('id', sala.id)
    .maybeSingle();
  verificar('anon lee las columnas públicas de su sala', publicas.data?.codigo === sala.codigo);

  const conAnfitrion = await anon.from('salas').select('id_anfitrion').eq('id', sala.id).maybeSingle();
  verificar(
    'anon NO puede leer id_anfitrion',
    !!conAnfitrion.error && /permission|permission denied/i.test(conAnfitrion.error.message)
  );

  const escribir = await anon.from('jugadores').insert({ id_sala: sala.id, nickname: 'Hack' });
  verificar('anon NO puede escribir tablas', !!escribir.error);

  const { error: errCrear } = await anon.rpc('crear_sala');
  verificar('anon NO puede crear salas', !!errCrear);

  const respuestas = await anon.from('preguntas_trivia').select('indice_correcto').limit(1);
  verificar('anon NO puede leer las respuestas correctas', !!respuestas.error);
}

console.log('\n═══ 2. PII mínima en perfil_por_correo ═══');
{
  const correo = `seg.perfil.${MARCA}@example.com`;
  const p2 = cliente(env.url, env.anon, `seg-p2-${MARCA}`);
  const alta = await p2.rpc('unirse_sala', {
    p_codigo: sala.codigo,
    p_nickname: `SegP2${MARCA}`.slice(0, 20),
    p_icono: 'Star',
    p_color: 'bg-purple-500',
    ...datosJugador(env, MARCA, 2),
    p_correo: correo,
  });
  verificar('alta con correo nuevo OK', !alta.error, alta.error?.message);

  const perfil = await anon.rpc('perfil_por_correo', { p_correo: correo });
  verificar('el perfil existe para el dueño del correo', perfil.data?.existe === true);
  verificar('NO devuelve apellido', perfil.data?.apellido === undefined);
  verificar('NO devuelve teléfono', perfil.data?.telefono === undefined);
  verificar(
    'devuelve solo las claves permitidas',
    JSON.stringify(Object.keys(perfil.data || {}).sort()) === '["existe","nickname","nombre"]',
    Object.keys(perfil.data || {}).join(',')
  );
}

console.log('\n═══ 3. Topes de entrada de juego ═══');
{
  await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'trivia' });
  await host.rpc('trivia_siguiente', { p_sala: sala.id });
  const { data: s } = await host.from('salas').select('juego').eq('id', sala.id).single();

  const malaOpcion = await p1.rpc('trivia_responder', {
    p_token: unido.data.token,
    p_opcion: 99,
    p_pregunta_id: s.juego.pregunta_id,
  });
  verificar('trivia rechaza opciones fuera de rango', /opción inválida/i.test(malaOpcion.error?.message || ''));

  const { error: errTerminar } = await host.rpc('terminar_partida', { p_sala: sala.id });
  await host.rpc('volver_al_lobby', { p_sala: sala.id });
  await host.rpc('seleccionar_juego', { p_sala: sala.id, p_juego: 'basta' });
  await host.rpc('basta_iniciar_ronda', { p_sala: sala.id });
  const { data: sb } = await host.from('salas').select('juego').eq('id', sala.id).single();
  const cat = sb.juego.categorias[0];
  const largo = 'x'.repeat(200);
  const envio = await p1.rpc('basta_enviar', {
    p_token: unido.data.token,
    p_id_categoria: cat,
    p_texto: largo,
  });
  verificar('basta acota la palabra a 60 caracteres', envio.data?.texto?.length === 60, `len=${envio.data?.texto?.length}`);

  if (!errTerminar) await host.rpc('terminar_partida', { p_sala: sala.id });
}

console.log('\n═══ 4. Rate limit de fuerza bruta ═══');
{
  // La sala debe estar en lobby: el rate limit cuenta identificadores
  // inexistentes, y una sala que ya arrancó corta antes de buscarlos.
  await host.rpc('volver_al_lobby', { p_sala: sala.id });
  let bloqueado = false;
  let primeraBloqueada = 0;
  for (let i = 1; i <= 30; i++) {
    const intento = await anon.rpc('entrar_con_identificador', {
      p_codigo: sala.codigo,
      p_identificador: `no-existe-${MARCA}-${i}@example.com`,
    });
    if (/demasiados intentos/i.test(intento.error?.message || '')) {
      bloqueado = true;
      primeraBloqueada = i;
      break;
    }
  }
  verificar('el login por identificador se bloquea tras N fallos', bloqueado, `primera bloqueada: ${primeraBloqueada}`);
  verificar('el bloqueo llega después de varios intentos (no antes)', primeraBloqueada >= 10, `i=${primeraBloqueada}`);
}

// Limpieza: libera el rate limit para futuros tests de esta corrida.
if (admin) await admin.from('intentos_acceso').delete().gte('id', 0);
await host.rpc('borrar_sala', { p_sala: sala.id });

console.log('\n══════════════════════════════════════════════════════════════');
console.log(`  RESULTADO: ${pasadas} OK · ${falladas} fallos`);
console.log('══════════════════════════════════════════════════════════════');
process.exit(falladas === 0 ? 0 : 1);
