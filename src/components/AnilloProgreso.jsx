// src/components/AnilloProgreso.jsx
//
// Anillo de cuenta regresiva en SVG puro (sin librerías):
//   - progreso 1 -> círculo lleno; 0 -> agotado.
//   - cambia de color según quede tiempo (normal / urgente / crítico).

import React from 'react';

const COLORES = {
  normal: '#F2B705',
  urgente: '#FB923C',
  critico: '#EF4444',
};

export default function AnilloProgreso({
  progreso = 1,
  tamano = 120,
  grosor = 8,
  texto = '',
  subtexto = '',
}) {
  const centro = tamano / 2;
  const radio = centro - grosor / 2 - 2;
  const circunferencia = 2 * Math.PI * radio;
  const dash = circunferencia * Math.max(0, Math.min(1, progreso));

  const color = progreso > 0.4 ? COLORES.normal : progreso > 0.18 ? COLORES.urgente : COLORES.critico;

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: tamano, height: tamano }}>
      <svg width={tamano} height={tamano} className="-rotate-90">
        <circle
          cx={centro}
          cy={centro}
          r={radio}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth={grosor}
        />
        <circle
          cx={centro}
          cy={centro}
          r={radio}
          fill="none"
          stroke={color}
          strokeWidth={grosor}
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circunferencia}`}
          style={{ transition: 'stroke-dasharray 60ms linear' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span
          className={`font-black tabular-nums ${progreso <= 0.18 ? 'text-red-400 animate-pulse' : 'text-white'}`}
          style={{ fontSize: tamano * 0.22 }}
        >
          {texto}
        </span>
        {subtexto && <span className="text-[10px] uppercase tracking-wider text-[#8B80B3]">{subtexto}</span>}
      </div>
    </div>
  );
}
