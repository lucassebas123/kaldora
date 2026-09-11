// src/utils/haptico.js
//
// VIBRACIÓN HÁPTICA del celular (Android/Chrome). En dispositivos sin la API
// (iOS, desktop) las funciones son no-ops silenciosos: nunca rompen nada.
// Se llaman junto a los sonidos (utils/sonidos.js) para duplicar el feedback.

const disponible = () =>
  typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

export function vibrar(patron) {
  if (!disponible()) return false;
  try {
    return navigator.vibrate(patron);
  } catch {
    return false;
  }
}

export const vibrarExito = () => vibrar([22, 45, 22]);
export const vibrarFallo = () => vibrar(90);
export const vibrarPasapalabra = () => vibrar(18);
export const vibrarUrgencia = () => vibrar([50, 70, 50, 70, 50]);
export const vibrarEliminado = () => vibrar([140, 60, 140, 60, 260]);
export const vibrarCelebracion = () => vibrar([30, 55, 30, 55, 100]);
export const vibrarVictoria = () => vibrar([45, 65, 45, 65, 60, 65, 180]);
