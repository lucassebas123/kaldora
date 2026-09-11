// src/hooks/useCuentaAtras.js
//
// Cuenta regresiva suave (60 fps) basada en DEADLINE absoluto, no en ticks:
//   - `fin` es una marca de tiempo ISO/timestamptz (la fija el SERVIDOR).
//   - `offsetReloj` compensa la deriva del reloj del dispositivo respecto
//     al anfitrión (medida por broadcast ping/pong).
//   - `congelada` (pausa del anfitrión) detiene el descuento sin perder el
//     restante al reanudar.
//
// Devuelve { msRestantes, progreso } con progreso en [0..1] (1 = lleno).

import { useEffect, useState } from 'react';

const TICK_MS = 50;

/**
 * Deadline absoluto a partir del INICIO que fija el servidor
 * (salas.juego.inicio = clock_timestamp) más la duración de la ronda.
 * El servidor guarda el arranque, no el fin: los clientes calculan
 * fin = inicio + duracion_ms (patrón del Rosco).
 */
export function calcularFin(inicio, duracionMs) {
  if (!inicio || !duracionMs) return null;
  return new Date(new Date(inicio).getTime() + duracionMs).toISOString();
}

export function useCuentaAtras({ fin, duracionMs, offsetReloj = 0, congelada = false }) {
  const calcular = () => {
    if (!fin || !duracionMs) return { msRestantes: 0, progreso: 0 };
    const ahora = Date.now() + offsetReloj;
    const restante = new Date(fin).getTime() - ahora;
    return {
      msRestantes: Math.max(0, restante),
      progreso: Math.max(0, Math.min(1, restante / duracionMs)),
    };
  };

  const [estado, setEstado] = useState(calcular);

  useEffect(() => {
    setEstado(calcular());
    if (!fin || congelada) return undefined;

    const intervalo = setInterval(() => setEstado(calcular()), TICK_MS);
    return () => clearInterval(intervalo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fin, duracionMs, offsetReloj, congelada]);

  return estado;
}

/** Formatea ms como "0:07.4" (para cuentas rápidas) o "0:07" (enteros). */
export function formatearMs(ms, conDecimas = false) {
  const total = Math.max(0, ms);
  const s = Math.floor(total / 1000);
  const min = Math.floor(s / 60);
  const seg = s % 60;
  if (!conDecimas) return `${min}:${String(seg).padStart(2, '0')}`;
  const decimas = Math.floor((total % 1000) / 100);
  return `${min}:${String(seg).padStart(2, '0')}.${decimas}`;
}
