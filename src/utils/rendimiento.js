// src/utils/rendimiento.js
//
// Detección de gama baja para ALIGERAR efectos (confeti, fondo, partículas).
// Se evalúa una sola vez al cargar el módulo: en una sala de 20-30 celulares
// conviene que cada dispositivo gaste lo mínimo posible.
//
// Criterios (cualquiera alcanza):
//   * prefers-reduced-motion activo
//   * <= 4 núcleos de CPU (navigator.hardwareConcurrency)
//   * <= 4 GB de RAM (navigator.deviceMemory, solo Chrome/Android)
//   * pantalla angosta (<= 480 px)
//
// En navegadores sin soporte, los valores quedan en "gama alta" (comportamiento
// actual), así que nunca se degrada de más.

const calcular = () => {
  if (typeof window === 'undefined') return false;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
    if ((navigator.hardwareConcurrency || 8) <= 4) return true;
    if ((navigator.deviceMemory || 8) <= 4) return true;
    if (window.innerWidth && window.innerWidth <= 480) return true;
    return false;
  } catch {
    return false;
  }
};

/** true en dispositivos modestos o con reduce-motion: efectos reducidos. */
export const GAMA_BAJA = calcular();

/** Factor para escalar cantidades de partículas/efectos (0.5 en gama baja). */
export const FACTOR_EFECTOS = GAMA_BAJA ? 0.5 : 1;
