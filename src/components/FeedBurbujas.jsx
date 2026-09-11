// src/components/FeedBurbujas.jsx
//
// Render de las burbujas en vivo de los paneles del anfitrión. El estado lo
// maneja el hook `useFeedBurbujas` (src/hooks/useFeedBurbujas.js).

import React from 'react';

/**
 * @param {Array} burbujas - [{ clave, texto, nota, bien }]
 *   texto: nickname · nota: "+920" | "✗" | palabra · bien: boolean|null
 */
export default function FeedBurbujas({ burbujas }) {
  if (!burbujas.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-30 flex flex-col-reverse gap-2">
      {burbujas.map((b) => (
        <div
          key={b.clave}
          className={`animate-burbuja-entra flex items-center gap-2 rounded-full border py-1.5 pl-2 pr-3 shadow-lg shadow-black/40 backdrop-blur ${
            b.bien === true
              ? 'border-green-400/40 bg-green-500/10'
              : b.bien === false
                ? 'border-red-400/40 bg-red-500/10'
                : 'border-white/15 bg-[#1B1035]/90'
          }`}
        >
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${
              b.bien === true ? 'bg-green-400' : b.bien === false ? 'bg-red-400' : 'bg-fuchsia-400'
            }`}
          />
          <span className="text-xs font-bold text-white">{b.texto}</span>
          {b.nota && (
            <span
              className={`text-[10px] font-black tabular-nums ${
                b.bien === true ? 'text-green-300' : b.bien === false ? 'text-red-300' : 'text-[#B8AFD9]'
              }`}
            >
              {b.nota}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}
