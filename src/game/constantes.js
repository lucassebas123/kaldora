// src/game/constantes.js
// Reglas y constantes de los cuatro juegos (espejo de las RPCs del servidor).
// `matiz` = tono HSL que tiñe el fondo y el theme-color por juego.

export const JUEGOS = {
  rosco: {
    id: 'rosco',
    nombre: 'El Rosco',
    emoji: '⭕',
    descripcion: 'Abecedario circular con reloj total: +100 acierto, −50 error.',
    color: 'from-amber-400 to-orange-500',
    acento: 'text-amber-300',
    matiz: 42,
  },
  trivia: {
    id: 'trivia',
    nombre: 'Trivia de Velocidad',
    emoji: '⚡',
    descripcion: '1000 pts que se derriten en 20 s. Rachas x2 y x3.',
    color: 'from-sky-400 to-cyan-500',
    acento: 'text-sky-300',
    matiz: 197,
  },
  basta: {
    id: 'basta',
    nombre: 'Basta!',
    emoji: '🎯',
    descripcion: '5 categorías contra el reloj. Quien termina primero dispara 10 s letales.',
    color: 'from-fuchsia-400 to-purple-500',
    acento: 'text-fuchsia-300',
    matiz: 292,
  },
  supervivencia: {
    id: 'supervivencia',
    nombre: 'Supervivencia',
    emoji: '💀',
    descripcion: 'Verdadero o Falso a eliminación súbita. Un error y quedás afuera.',
    color: 'from-red-400 to-rose-600',
    acento: 'text-red-300',
    matiz: 352,
  },
};

/** Tono por defecto de la plataforma (sala de espera / lobby). */
export const MATIZ_BASE = 270;

export const ROSCO = {
  // Tiempo duplicado (2026-09): 5 min por defecto para poder pensar cada letra.
  SEGUNDOS_DEFECTO: 300,
  DURACIONES: [240, 360, 600],
  GRACIA_MS: 2500,
  PUNTOS_ACIERTO: 100,
  PUNTOS_ERROR: -50,
};

export const TRIVIA = {
  DURACION_MS: 20000,
  PUNTOS_BASE: 1000,
};

export function multiplicadorRacha(racha) {
  if (racha >= 5) return 3;
  if (racha >= 3) return 2;
  return 1;
}

export const BASTA = {
  CATEGORIAS: 5,
  SEGUNDOS_LETALES: 10,
  PUNTOS_UNICA: 10,
  PUNTOS_REPETIDA: 5,
};

export const SUPERVIVENCIA = {
  DURACION_MS: 10000,
  PUNTOS_ACIERTO: 25,
};
