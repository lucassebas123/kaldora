// src/components/NumeroAnimado.jsx
//
// Odómetro: interpola el número mostrado hacia el valor objetivo con una
// curva easeOutCubic. Usado para los puntos del jugador (el número "cuenta"
// en lugar de saltar seco). Respeta prefers-reduced-motion (sin animación).

import React, { useEffect, useRef, useState } from 'react';

export default function NumeroAnimado({ valor = 0, className = '', duracionMs = 550 }) {
  const [mostrado, setMostrado] = useState(valor);
  const valorRef = useRef(valor);
  const rafRef = useRef(0);

  useEffect(() => {
    const desde = valorRef.current;
    const hasta = valor;
    if (desde === hasta) return undefined;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      valorRef.current = hasta;
      setMostrado(hasta);
      return undefined;
    }

    const t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    const paso = (t) => {
      const k = Math.min(1, (t - t0) / duracionMs);
      const suave = 1 - Math.pow(1 - k, 3);
      setMostrado(Math.round(desde + (hasta - desde) * suave));
      if (k < 1) {
        rafRef.current = requestAnimationFrame(paso);
      } else {
        valorRef.current = hasta;
      }
    };
    rafRef.current = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(rafRef.current);
  }, [valor, duracionMs]);

  return <span className={className}>{mostrado}</span>;
}
