// src/components/AvisoActualizacion.jsx
//
// Detector de VERSIÓN VIEJA: cuando la pestaña quedó corriendo un bundle
// anterior al deploy actual (clásico de las SPAs: la app desplegó una
// actualización pero la pestaña abierta sigue con el JS viejo en memoria),
// compara el hash del bundle cargado contra el del index.html fresco del
// servidor y ofrece recargar con un botón discreto. No interrumpe partidas.
//
// Es lo que evita el clásico "en el celular funciona y en la web no":
// la pestaña vieja se entera sola de que hay una versión nueva.

import React, { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';

/** Hash del bundle que esta pestaña está ejecutando (ej: "index-BDZBpdNr"). */
function hashCargado() {
  const src = document.querySelector('script[src*="/assets/index-"]')?.src || '';
  return src.match(/index-[^.]+/)?.[0] || null;
}

export default function AvisoActualizacion() {
  const [nuevaVersion, setNuevaVersion] = useState(false);
  const cargado = useRef(hashCargado());

  useEffect(() => {
    if (!cargado.current) return undefined;
    let vivo = true;

    async function chequear() {
      try {
        const res = await fetch(`/index.html?chk=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const html = await res.text();
        const hash = html.match(/assets\/(index-[^."]+)/)?.[1] || null;
        if (vivo && hash && cargado.current && hash !== cargado.current) {
          setNuevaVersion(true);
        }
      } catch {
        /* sin conexión: nada que avisar */
      }
    }

    chequear();
    const intervalo = setInterval(chequear, 60000);
    const alVisibilidad = () => {
      if (document.visibilityState === 'visible') chequear();
    };
    document.addEventListener('visibilitychange', alVisibilidad);
    return () => {
      vivo = false;
      clearInterval(intervalo);
      document.removeEventListener('visibilitychange', alVisibilidad);
    };
  }, []);

  if (!nuevaVersion) return null;
  return (
    <div className="fixed flotante-abajo-centro left-1/2 z-50 -translate-x-1/2">
      <button
        onClick={() => window.location.reload()}
        className="flex items-center gap-2 rounded-full border border-amber-400/40 bg-[#1B1035]/95 px-4 py-2 text-xs font-bold text-amber-200 shadow-xl shadow-black/40 backdrop-blur hover:brightness-110 transition"
      >
        <RefreshCw size={13} />
        Hay una nueva versión — actualizar
      </button>
    </div>
  );
}
