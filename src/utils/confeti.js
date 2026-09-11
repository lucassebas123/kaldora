// src/utils/confeti.js
//
// Envoltorio de canvas-confetti con la paleta de KALDORA. Tres recetas:
// ráfaga (acierto importante), explosión (momento épico) y lluvia (podio).
// Todo con disableForReducedMotion para respetar la configuración del sistema.

import confetti from 'canvas-confetti';

const PALETA = ['#F2B705', '#D946EF', '#38BDF8', '#4ADE80', '#A78BFA', '#FB7185'];

export function confetiRafaga({ x = 0.5, y = 0.65, particulas = 70, spread = 80 } = {}) {
  try {
    confetti({
      particleCount: particulas,
      spread,
      startVelocity: 36,
      origin: { x, y },
      colors: PALETA,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
  } catch {
    /* sin canvas disponible */
  }
}

export function confetiExplosion() {
  try {
    confetti({
      particleCount: 110,
      spread: 110,
      startVelocity: 42,
      origin: { x: 0.5, y: 0.55 },
      colors: PALETA,
      zIndex: 9999,
      disableForReducedMotion: true,
    });
  } catch {
    /* sin canvas disponible */
  }
}

export function confetiLluvia(duracionMs = 1800, particulas = 55) {
  try {
    const hasta = Date.now() + duracionMs;
    const intervalo = setInterval(() => {
      if (Date.now() > hasta) {
        clearInterval(intervalo);
        return;
      }
      confetti({
        particleCount: particulas,
        spread: 80,
        startVelocity: 32,
        origin: { x: Math.random(), y: Math.random() * 0.25 },
        colors: PALETA,
        zIndex: 9999,
        disableForReducedMotion: true,
      });
    }, 240);
  } catch {
    /* sin canvas disponible */
  }
}
