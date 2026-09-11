// src/components/FeedBurbujas.jsx
//
// Burbujas en vivo para el panel del anfitrión: cada respuesta/palabra que
// llega por broadcast aparece como burbuja flotante en el borde inferior
// derecho y se apaga sola (2.6 s). Hook `useFeedBurbujas` + componente de
// render. Cero escrituras: puro broadcast que ya viaja en el canal de la sala.

import React, { useCallback, useEffect, useState } from 'react';

const VIDA_MS = 2600;
const MAX_BURBUJAS = 7;

export function useFeedBurbujas() {
  const [burbujas, setBurbujas] = useState([]);

  useEffect(() => {
    const intervalo = setInterval(() => {
      const ahora = Date.now();
      setBurbujas((actuales) =>
        actuales.some((b) => ahora - b.nace > VIDA_MS)
          ? actuales.filter((b) => ahora - b.nace <= VIDA_MS)
          : actuales
      );
    }, 500);
    return () => clearInterval(intervalo);
  }, []);

  const push = useCallback((burbuja) => {
    setBurbujas((prev) =>
      [...prev, { ...burbuja, clave: Date.now() + Math.random(), nace: Date.now() }].slice(-MAX_BURBUJAS)
    );
  }, []);

  return { burbujas, push };
}

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
