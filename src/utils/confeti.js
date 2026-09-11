// src/utils/confeti.js
//
// Envoltorio de canvas-confetti con la paleta de KALDORA. Recetas:
//   * ráfaga      -> acierto importante (trivia x2/x3, basta completo)
//   * explosión   -> momento épico (rosco completo)
//   * lluvia      -> festejo continuo acotado
//   * cañones     -> dos cañones laterales (podio)
//   * celebración -> secuencia de podio en capas (~6 s) + goteo posterior
// Todo con disableForReducedMotion: respeta la configuración del sistema.

import confetti from 'canvas-confetti';

const PALETA = ['#F2B705', '#D946EF', '#38BDF8', '#4ADE80', '#A78BFA', '#FB7185'];
const ORO = ['#F2B705', '#FFD966', '#FFC300', '#FFF3B0', '#FF9F1C', '#FFFFFF'];

/** Disparo seguro: sin canvas o con reduce-motion no rompe nunca. */
function disparo(opciones = {}) {
  try {
    confetti({
      zIndex: 9999,
      disableForReducedMotion: true,
      colors: PALETA,
      ...opciones,
    });
  } catch {
    /* sin canvas disponible */
  }
}

/** Dos cañones desde los bordes inferiores (el clásico "festejo total"). */
export function confetiCanones({ paleta = PALETA, particulas = 80 } = {}) {
  disparo({
    particleCount: particulas,
    angle: 58,
    spread: 62,
    startVelocity: 58,
    origin: { x: 0, y: 0.72 },
    colors: paleta,
  });
  disparo({
    particleCount: particulas,
    angle: 122,
    spread: 62,
    startVelocity: 58,
    origin: { x: 1, y: 0.72 },
    colors: paleta,
  });
}

export function confetiRafaga({ x = 0.5, y = 0.65, particulas = 70, spread = 80 } = {}) {
  disparo({
    particleCount: particulas,
    spread,
    startVelocity: 36,
    origin: { x, y },
  });
}

export function confetiExplosion() {
  disparo({
    particleCount: 130,
    spread: 120,
    startVelocity: 44,
    origin: { x: 0.5, y: 0.55 },
    shapes: ['star', 'circle'],
  });
}

export function confetiLluvia(duracionMs = 1800, particulas = 55) {
  const hasta = Date.now() + duracionMs;
  const intervalo = setInterval(() => {
    if (Date.now() > hasta) {
      clearInterval(intervalo);
      return;
    }
    disparo({
      particleCount: particulas,
      spread: 80,
      startVelocity: 32,
      origin: { x: Math.random(), y: Math.random() * 0.25 },
    });
  }, 240);
  return () => clearInterval(intervalo);
}

/**
 * Celebración de PODIO: secuencia en capas (~6 s) con cañones laterales,
 * estallidos centrales y lluvia de estrellas. Con `gano` la paleta es dorada
 * y la densidad sube. Devuelve una función para cortarla (unmount).
 */
export function celebracionPodio({ gano = false } = {}) {
  const paleta = gano ? ORO : PALETA;
  const timers = [];
  const agendar = (fn, ms) => timers.push(setTimeout(fn, ms));

  agendar(() => confetiCanones({ paleta }), 80);
  agendar(
    () =>
      disparo({
        particleCount: 150,
        spread: 130,
        startVelocity: 48,
        origin: { x: 0.5, y: 0.5 },
        colors: paleta,
        shapes: ['star', 'circle'],
        scalar: 1.1,
      }),
    260
  );
  agendar(() => confetiCanones({ paleta, particulas: 60 }), 1300);
  agendar(
    () =>
      disparo({
        particleCount: 110,
        angle: 90,
        spread: 110,
        startVelocity: 52,
        origin: { x: 0.5, y: 0.4 },
        colors: paleta,
      }),
    2200
  );
  agendar(() => confetiCanones({ paleta, particulas: 90 }), 3400);
  agendar(
    () =>
      disparo({
        particleCount: 140,
        spread: 125,
        startVelocity: 46,
        origin: { x: 0.5, y: 0.55 },
        colors: paleta,
        shapes: ['star', 'circle'],
      }),
    4700
  );

  // Lluvia de fondo mientras dura la secuencia.
  const lluvia = setInterval(() => {
    disparo({
      particleCount: gano ? 26 : 18,
      spread: 70,
      startVelocity: 26,
      gravity: 0.85,
      ticks: 260,
      origin: { x: Math.random(), y: -0.05 },
      colors: paleta,
    });
  }, gano ? 260 : 380);
  agendar(() => clearInterval(lluvia), gano ? 6400 : 5400);

  return () => {
    timers.forEach(clearTimeout);
    clearInterval(lluvia);
  };
}

/**
 * Goteo festivo: pedacitos cayendo cada `cadaMs` durante `duracionMs`.
 * Pensado para que quien mira el podio unos segundos tarde igual vea algo.
 */
export function confetiGoteo({ duracionMs = 14000, cadaMs = 800 } = {}) {
  const intervalo = setInterval(() => {
    disparo({
      particleCount: 10,
      spread: 55,
      startVelocity: 18,
      gravity: 0.9,
      ticks: 300,
      scalar: 0.9,
      origin: { x: Math.random(), y: -0.05 },
    });
  }, cadaMs);
  const fin = setTimeout(() => clearInterval(intervalo), duracionMs);
  return () => {
    clearInterval(intervalo);
    clearTimeout(fin);
  };
}
