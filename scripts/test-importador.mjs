// scripts/test-importador.mjs
//
// PRUEBAS DEL IMPORTADOR UNIVERSAL (Carga Masiva Inteligente) — 6 escenarios:
//   1. Trivia: mapeo de correcta (texto exacto / índice 1-based / 0-based /
//      marcador de letra) → opciones + radio correcto.
//   2. Supervivencia: sanitización booleana heterogénea (F, falso, False, V,
//      verdadero, True, si/no, 1/0) → es_verdadera estricta.
//   3. El Rosco: límites estrictos (>3 columnas bloqueada; letra = 1 char).
//   4. Carga parcial: 100 líneas con una rota → 99 válidas + "Línea 42".
//   5. Fuga de contexto: el mismo texto se re-evalúa bajo las reglas del modo.
//   6. Sincronización reactiva: consolidarTrivia NO desindexa la correcta.
//   7. (bonus) Lectura por chunks de archivos grandes sin bloquear.
//
// Uso: node scripts/test-importador.mjs

import {
  importarBanco,
  consolidarTrivia,
  leerArchivoPorChunks,
  MAX_TEXTO,
} from '../src/utils/importador.js';

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

// =============================================================================
console.log('\n═══ 1. TRIVIA — mapeo de la correcta (texto exacto, índice, letra) ═══');
// =============================================================================
{
  // Última columna = texto EXACTO de una opción (no es una opción extra).
  const r1 = importarBanco('¿Río más largo? | Nilo | Amazonas | Yangtsé | Amazonas', 'trivia');
  verificar('texto exacto: "Amazonas" mapea a la opción 2 (índice 1)',
    r1.items.length === 1 &&
    JSON.stringify(r1.items[0].opciones) === JSON.stringify(['Nilo', 'Amazonas', 'Yangtsé']) &&
    r1.items[0].indice_correcto === 1);

  // Índice 1-based natural ("3" = tercera opción → índice 2).
  const r2 = importarBanco('¿Cuánto es 12x12? | 124 | 132 | 144 | 3', 'trivia');
  verificar('índice 1-based: "3" → índice 2 (144)', r2.items[0]?.indice_correcto === 2);

  // Índice 0-based si viene un 0.
  const r3 = importarBanco('P? | a | b | 0', 'trivia');
  verificar('índice 0-based: "0" → índice 0 (a)', r3.items[0]?.indice_correcto === 0);

  // Marcador de letra: "(b)". (El marcador tiene prioridad sobre el texto:
  // si no, el buscador de texto matcheaba el marcador consigo mismo.)
  const r4 = importarBanco('¿Color? | Rojo | Verde | Azul | b', 'trivia');
  verificar('marcador de letra: "b" → índice 1 (Verde), y "b" no queda como opción',
    r4.items[0]?.indice_correcto === 1 && r4.items[0]?.opciones.length === 3);

  // Última columna que no matchea ninguna opción: interpretación tolerada —
  // se agrega como opción extra marcada como correcta.
  const r5 = importarBanco('P? | a | b | zzz', 'trivia');
  verificar('correcta fuera de opciones → se agrega como opción (tolerado)',
    r5.items.length === 1 && r5.items[0].opciones.length === 3 && r5.items[0].opciones[2] === 'zzz');

  // CSV con comillas que contienen el delimitador.
  const r6 = importarBanco('"Pregunta, con coma" | A | B | A', 'trivia');
  verificar('comillas: la coma dentro de comillas no parte la línea',
    r6.items[0]?.pregunta === 'Pregunta, con coma' && r6.items[0]?.indice_correcto === 0);

  // 2 opciones válidas; 5 opciones → descartada; correcta no matcheada →
  // interpretación tolerada (se agrega como opción marcada correcta).
  const r7 = importarBanco('P | a | b | a\nP2 | a | b | c | d | e | a\nP3 | solo | una', 'trivia');
  verificar('lote mixto: válida + 5-opciones descartada + tolerada (2 items)',
    r7.items.length === 2 &&
    r7.items[0].opciones.length === 2 &&
    r7.descartes.length === 1 && r7.descartes[0].n === 2);
}

// =============================================================================
console.log('\n═══ 2. SUPERVIVENCIA — sanitización booleana heterogénea ═══');
// =============================================================================
{
  const casos = [
    ['Los pingüinos viven en el Ártico | F', false],
    ['Los pingüinos viven en el Ártico | falso', false],
    ['Los pingüinos viven en el Ártico, False', false],
    ['Los pingüinos viven en el Ártico | 0', false],
    ['El monte Everest es la montaña más alta | V', true],
    ['El monte Everest es la montaña más alta | verdadero', true],
    ['El monte Everest es la montaña más alta | True', true],
    ['El monte Everest es la montaña más alta - SI', true],
  ];
  const texto = casos.map(([f]) => f).join('\n');
  const r = importarBanco(texto, 'supervivencia');
  // 8 líneas pero 4+4 preguntas idénticas → la DEDUPLICACIÓN colapsa a 2.
  verificar(`8 líneas → 2 ítems únicos (deduplicación por pregunta) (${r.items.length})`, r.items.length === 2 && r.descartes.length === 0);
  verificar('F/falso/False/0 → es_verdadera = false',
    r.items.filter((x) => x.pregunta.startsWith('Los pingüinos')).every((x) => x.es_verdadera === false));
  verificar('V/verdadero/True/SI → es_verdadera = true',
    r.items.filter((x) => x.pregunta.startsWith('El monte')).every((x) => x.es_verdadera === true));

  // Frase sin booleano al final → descartada.
  const r2 = importarBanco('Esta frase no tiene valor de verdad', 'supervivencia');
  verificar('frase sin V/F → descartada', r2.items.length === 0 && r2.descartes.length === 1);
}

// =============================================================================
console.log('\n═══ 3. EL ROSCO — límites estrictos ═══');
// =============================================================================
{
  const r = importarBanco('A | Capital de Francia | París\nB - Animal que da leche - Vaca\nC. País de Bogotá: Colombia\nÑ | Año | Año', 'rosco');
  verificar('4 formatos válidos (incluye Ñ y separadores débiles) → 4 items', r.items.length === 4);
  verificar('items bien armados', r.items[0].letra === 'A' && r.items[0].respuesta === 'París');

  const r2 = importarBanco('A | Pregunta | Respuesta | Columna extra', 'rosco');
  verificar('>3 columnas → BLOQUEADA con razón específica',
    r2.items.length === 0 &&
    r2.descartes[0]?.razon?.includes('más de 3 columnas'));

  const r3 = importarBanco('AB | P | R', 'rosco');
  verificar('letra de dos caracteres → descartada', r3.items.length === 0);

  const r4 = importarBanco('1 | P | R', 'rosco');
  verificar('letra numérica → descartada', r4.items.length === 0);
}

// =============================================================================
console.log('\n═══ 4. CARGA PARCIAL — 99 válidas + "Línea 42 ignorada" ═══');
// =============================================================================
{
  const lineas = [];
  for (let i = 1; i <= 100; i++) {
    lineas.push(i === 42 ? 'ESTA LINEA ESTA ROTA ===' : `¿Pregunta número ${i}? | op${i}a | op${i}b | op${i}a`);
  }
  const r = importarBanco(lineas.join('\n'), 'trivia');
  verificar(`carga parcial: 99 items reconocidos (${r.items.length})`, r.items.length === 99);
  verificar('exactamente 1 descarte', r.descartes.length === 1);
  const d = r.descartes[0];
  verificar('el descarte apunta a la LÍNEA 42 (numeración original)', d.n === 42);
  verificar('el mensaje de log es específico: "Línea 42 ignorada por formato inválido"',
    `Línea ${d.n} ignorada por formato inválido` === 'Línea 42 ignorada por formato inválido');
  verificar('el resto del lote NO se descarta (items siguen indexados en orden)',
    r.items[0].pregunta === '¿Pregunta número 1?' && r.items[41].pregunta === '¿Pregunta número 43?');
}

// =============================================================================
console.log('\n═══ 5. FUGA DE CONTEXTO — re-evaluación bajo las reglas del modo ═══');
// =============================================================================
{
  const texto = '¿Capital de Francia? | París | Roma | París\n¿2+2 es 4? | V';
  const comoTrivia = importarBanco(texto, 'trivia');
  const comoSupervivencia = importarBanco(texto, 'supervivencia');
  verificar('mismo texto, modo trivia: 1 item de trivia', comoTrivia.items.length === 1 && comoTrivia.items[0].opciones.length === 2);
  verificar('mismo texto, modo supervivencia: re-evaluado (solo la línea con V/F es ítem)',
    comoSupervivencia.items.length === 1 && typeof comoSupervivencia.items[0].es_verdadera === 'boolean');
  verificar('cambio de modo NO conserva items del modo anterior (estado separado)',
    comoTrivia.items[0].indice_correcto !== undefined && comoSupervivencia.items[0].indice_correcto === undefined);
}

// =============================================================================
console.log('\n═══ 6. SINCRONIZACIÓN REACTIVA — consolidar sin desindexar ═══');
// =============================================================================
{
  // El bug viejo: marcar la opción 4 correcta y dejar la 2 vacía → la
  // correcta pasaba a ser la 3. consolidarTrivia recalcula POR POSICIÓN.
  const r1 = consolidarTrivia({ pregunta: 'P', opciones: ['A', '', 'C', 'D'], indice_correcto: 3 });
  verificar('vacío en medio: la correcta sigue siendo "D" (índice 2 tras filtrar)',
    r1.opciones.length === 3 && r1.indice_correcto === 2 &&
    r1.opciones[r1.indice_correcto] === 'D' && !r1.correctaPerdida);

  const r2 = consolidarTrivia({ pregunta: 'P', opciones: ['A', 'B', '', ''], indice_correcto: 1 });
  verificar('vacíos al final: índice intacto', r2.opciones.length === 2 && r2.indice_correcto === 1 && r2.opciones[1] === 'B');

  const r3 = consolidarTrivia({ pregunta: 'P', opciones: ['A', ''], indice_correcto: 1 });
  verificar('la correcta marcada está vacía → correctaPerdida (la UI bloquea el guardado)', r3.correctaPerdida === true);

  // Deduplicación: dos líneas idénticas → 1 item.
  const r4 = importarBanco('A | P | R\nA | P | R', 'rosco');
  verificar('deduplicación: líneas idénticas → 1 item', r4.items.length === 1);
}

// =============================================================================
console.log('\n═══ 7. LECTURA POR CHUNKS — archivos grandes sin bloquear ═══');
// =============================================================================
{
  const parte = '¿Pregunta | a | b | a\n'.repeat(20000); // ~500 KB
  const blob = new Blob([parte, parte, parte, parte]); // ~2 MB, 4 chunks+ si fuera más chico
  const texto = await leerArchivoPorChunks(blob, () => {});
  verificar('lectura por chunks: contenido íntegro', texto === parte.repeat(4));

  // Tope de tamaño: rechaza antes de leer.
  const enorme = new Blob([new Uint8Array(MAX_TEXTO + 1)]);
  let rechazo = null;
  try {
    await leerArchivoPorChunks(enorme);
  } catch (e) {
    rechazo = e;
  }
  verificar(`archivo mayor a ${MAX_TEXTO / 1048576} MB → rechazado con mensaje claro`,
    rechazo?.message?.includes('Dividilo'));
}

console.log(`\nRESULTADO IMPORTADOR: ${pasadas} OK · ${falladas} fallos`);
process.exit(falladas > 0 ? 1 : 0);
