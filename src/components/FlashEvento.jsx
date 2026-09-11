// src/components/FlashEvento.jsx
//
// Velo de color a pantalla completa con auto-limpieza: verde al acertar,
// rojo al fallar. Monta/desmonta con `clave` para que la animación se
// reinicie en cada evento. `tipo = null` no renderiza nada.

import React from 'react';

const VELO = {
  acierto: 'bg-[radial-gradient(ellipse_at_center,rgba(74,222,128,0.4)_0%,rgba(74,222,128,0)_70%)]',
  fallo: 'bg-[radial-gradient(ellipse_at_center,rgba(248,113,113,0.45)_0%,rgba(248,113,113,0)_70%)]',
  alerta: 'bg-[radial-gradient(ellipse_at_center,rgba(251,191,36,0.4)_0%,rgba(251,191,36,0)_70%)]',
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
