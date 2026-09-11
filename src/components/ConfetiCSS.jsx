// src/components/ConfetiCSS.jsx
//
// Fallback de confeti 100% DOM/CSS para cuando canvas-confetti no puede
// dibujar (navegador sin canvas 2D). En navegadores normales no renderiza
// nada: el confeti real corre por canvas.

import React from 'react';

const PALETA = ['#F2B705', '#D946EF', '#38BDF8', '#4ADE80', '#A78BFA', '#FB7185'];

const HAY_CANVAS =
  typeof window !== 'undefined' &&
  (() => {
    try {
      return Boolean(document.createElement('canvas').getContext('2d'));
    } catch {
      return false;
    }
  })();

export default function ConfetiCSS({ cantidad = 64 }) {
  if (HAY_CANVAS) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[9999] overflow-hidden" aria-hidden="true">
      {Array.from({ length: cantidad }).map((_, i) => (
        <span
          key={i}
          className="animate-confeti-cae absolute top-[-12vh] block h-2.5 w-1.5 rounded-sm"
          style={{
            left: `${(i * 37 + 7) % 100}%`,
            backgroundColor: PALETA[i % PALETA.length],
            animationDelay: `${(i % 14) * 200}ms`,
            animationDuration: `${2400 + (i % 5) * 500}ms`,
          }}
        />
      ))}
    </div>
  );
}
