// scripts/test-logica.mjs
// Pruebas unitarias de la lógica pura de Kaldora (reglas espejo del servidor).
// Uso: node scripts/test-logica.mjs

import { multiplicadorRacha, JUEGOS, ROSCO, TRIVIA, BASTA, SUPERVIVENCIA } from '../src/game/constantes.js';
import { formatearTiempo } from '../src/utils/formato.js';

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

console.log('— Reglas de racha (Trivia) —');
verificar('racha 0 → x1', multiplicadorRacha(0) === 1);
verificar('racha 2 → x1', multiplicadorRacha(2) === 1);
verificar('racha 3 → x2', multiplicadorRacha(3) === 2);
verificar('racha 4 → x2', multiplicadorRacha(4) === 2);
verificar('racha 5 → x3', multiplicadorRacha(5) === 3);
verificar('racha 9 → x3', multiplicadorRacha(9) === 3);

console.log('— Puntajes definidos —');
verificar('rosco: +100/-50', ROSCO.PUNTOS_ACIERTO === 100 && ROSCO.PUNTOS_ERROR === -50);
verificar('rosco: reloj total de 150 s por defecto', ROSCO.SEGUNDOS_DEFECTO === 150 && Array.isArray(ROSCO.DURACIONES));
verificar('trivia: 1000 base / 20 s', TRIVIA.PUNTOS_BASE === 1000 && TRIVIA.DURACION_MS === 20000);
verificar('basta: 10 s letales, única 10 / repetida 5', BASTA.SEGUNDOS_LETALES === 10 && BASTA.PUNTOS_UNICA === 10 && BASTA.PUNTOS_REPETIDA === 5);
verificar('supervivencia: +25 por acierto', SUPERVIVENCIA.PUNTOS_ACIERTO === 25);

console.log('— Juegos registrados —');
verificar('exactamente 4 juegos', Object.keys(JUEGOS).length === 4);
verificar('ids correctos', ['rosco', 'trivia', 'basta', 'supervivencia'].every((k) => JUEGOS[k]?.id === k));

console.log('— Formato de tiempo —');
verificar('formatearTiempo(0) = 00:00', formatearTiempo(0) === '00:00');
verificar('formatearTiempo(65) = 01:05', formatearTiempo(65) === '01:05');
verificar('formatearTiempo(-3) = 00:00 (piso)', formatearTiempo(-3) === '00:00');

console.log('— Cobertura de UI —');
verificar('JUEGOS con descripción y color para las tarjetas', Object.values(JUEGOS).every((j) => j.nombre && j.descripcion && j.emoji));

console.log(`\nResultado: ${pasadas} OK, ${falladas} fallos`);
process.exit(falladas > 0 ? 1 : 0);
