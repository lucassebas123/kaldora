// src/components/NumeroAnimado.jsx
//
// Odómetro: interpola el número mostrado hacia el valor objetivo con una
// curva easeOutCubic. Usado para los puntos del jugador (el número "cuenta"
// en lugar de saltar seco). Respeta prefers-reduced-motion (sin animación).

import React, { useEffect, useRef, useState } from 'react';

export default function NumeroAnimado({ valor = 0, className = '', duracionMs = 550 }) {
  const [mostrado, setMostrado] = useState(valor);
  // Último valor DIBUJADO (no el último objetivo): si `valor` cambia a mitad
  // de animación, el odómetro re-arranca desde donde está, sin saltar atrás.
  const mostradoRef = useRef(valor);
  const rafRef = useRef(0);
  // Una sola lectura por montaje: con "reducir movimiento" se dibuja el valor
  // directo (sin animar) y el efecto no necesita setState sincrónico.
  const [reducido] = useState(
    () => typeof window !== 'undefined' && Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)
  );

  useEffect(() => {
    const desde = mostradoRef.current;
    const hasta = valor;
    if (reducido) {
      mostradoRef.current = hasta;
      return undefined;
    }
    if (desde === hasta) return undefined;

    const t0 = performance.now();
    cancelAnimationFrame(rafRef.current);
    const paso = (t) => {
      const k = Math.min(1, (t - t0) / duracionMs);
      const suave = 1 - Math.pow(1 - k, 3);
      const actual = Math.round(desde + (hasta - desde) * suave);
      mostradoRef.current = actual;
      setMostrado(actual);
      if (k < 1) {
        rafRef.current = requestAnimationFrame(paso);
      } else {
        mostradoRef.current = hasta;
      }
    };
    rafRef.current = requestAnimationFrame(paso);
    return () => cancelAnimationFrame(rafRef.current);
  }, [valor, duracionMs, reducido]);

  return <span className={className}>{reducido ? valor : mostrado}</span>;
}
