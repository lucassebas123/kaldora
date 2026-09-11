// src/hooks/useFeedBurbujas.js
//
// Burbujas en vivo para los paneles del anfitrión: cada respuesta/palabra que
// llega por broadcast aparece como burbuja flotante y se apaga sola (2.6 s).
// Cero escrituras: puro broadcast que ya viaja en el canal de la sala.

import { useCallback, useEffect, useState } from 'react';

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
