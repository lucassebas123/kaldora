// src/components/FlashEvento.jsx
//
// Velo de color a pantalla completa con auto-limpieza: verde al acertar,
// rojo al fallar. Monta/desmonta con `clave` para que la animación se
// reinicie en cada evento. `tipo = null` no renderiza nada.

import React from 'react';

const VELO = {
  acierto: 'bg-green-500/25',
  fallo: 'bg-red-500/25',
  alerta: 'bg-amber-500/25',
};

export default function FlashEvento({ tipo, clave, duracionMs = 550 }) {
  if (!tipo || clave == null) return null;
  return (
    <div
      key={clave}
      style={{ animationDuration: `${duracionMs}ms` }}
      className={`pointer-events-none fixed inset-0 z-40 animate-flash-velo ${VELO[tipo] || VELO.alerta}`}
    />
  );
}
