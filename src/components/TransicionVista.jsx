// src/components/TransicionVista.jsx
//
// Envuelve el contenido con una animación de entrada que se reinicia cuando
// cambia `claveVista` (lobby → juego → podio). Solo anima la ENTRADA:
// la pausa NO cambia la clave, así que el juego no se remonta (no se pierde
// el estado de lo que el jugador estaba escribiendo).

import React from 'react';

export default function TransicionVista({ claveVista, className = '', children }) {
  return (
    <div key={claveVista} className={`animate-entrada-vista ${className}`}>
      {children}
    </div>
  );
}
