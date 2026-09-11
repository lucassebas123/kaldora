// src/utils/formato.js
// Utilidades puras de formato compartidas por todos los juegos.

/** Formatea segundos como mm:ss (cronómetros). */
export function formatearTiempo(segundos) {
  const s = Math.max(0, Math.floor(segundos || 0));
  const min = Math.floor(s / 60).toString().padStart(2, '0');
  const seg = (s % 60).toString().padStart(2, '0');
  return `${min}:${seg}`;
}

/** Formatea ms como "7.4 s" (cuentas rápidas de trivia/supervivencia). */
export function formatearSegundos(ms) {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** Marca la hora de ahora de forma consistente (ms). */
export function ahora() {
  return Date.now();
}
