// src/constants/avatares.js
// Catálogo compartido de íconos y colores para los avatares de jugadores.
// Se usa en la landing (elección automática) y en AvatarChip/RankingJugadores.

import {
  Trophy,
  Zap,
  Flame,
  Crown,
  Rocket,
  Target,
  Ghost,
  Shield,
  Sword,
  Heart,
  Star,
  Sparkles,
  Smile,
  Gamepad2,
  Compass,
  Feather,
  Skull,
  Eye,
  Music,
  Award,
} from 'lucide-react';

// Mapa nombre -> componente. Se guarda el nombre (string) en la base de datos
// y se resuelve al componente real solo al momento de renderizar.
export const ICONOS_DISPONIBLES = {
  Trophy,
  Zap,
  Flame,
  Crown,
  Rocket,
  Target,
  Ghost,
  Shield,
  Sword,
  Heart,
  Star,
  Sparkles,
  Smile,
  Gamepad2,
  Compass,
  Feather,
  Skull,
  Eye,
  Music,
  Award,
};

export const NOMBRES_ICONOS = Object.keys(ICONOS_DISPONIBLES);

export const COLORES_DISPONIBLES = [
  'bg-red-500',
  'bg-blue-500',
  'bg-green-500',
  'bg-yellow-500',
  'bg-purple-500',
  'bg-pink-500',
  'bg-orange-500',
  'bg-teal-500',
];

/**
 * Devuelve el componente de ícono de Lucide a partir de su nombre guardado en 'equipos'.
 * Si el nombre no existe (dato corrupto o viejo), cae a Star como respaldo visual.
 */
export function obtenerIcono(nombreIcono) {
  return ICONOS_DISPONIBLES[nombreIcono] || Star;
}

/**
 * Determina si una combinación ícono+color ya está tomada por otro equipo de la sala.
 */
export function combinacionTomada(equipos, icono, color, idEquipoPropio = null) {
  return equipos.some(
    (e) => e.id !== idEquipoPropio && e.icono === icono && e.color === color
  );
}
