// src/components/BannerConexion.jsx
//
// Aviso discreto de conexión degradada (Realtime mudo > 12 s o sin red).
// No bloquea el juego: los deadlines y la validación viven en el servidor, y
// el polling de respaldo re-sincroniza el estado apenas vuelve la conexión.

import React from 'react';
import { WifiOff } from 'lucide-react';

export default function BannerConexion({ visible, texto }) {
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="w-full rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-center text-xs font-bold text-amber-200"
    >
      <WifiOff className="inline -mt-0.5 mr-1.5" size={13} />
      {texto || 'Reconectando… tus respuestas se guardan igual.'}
    </div>
  );
}
