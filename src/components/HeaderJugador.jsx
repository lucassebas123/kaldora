// src/components/HeaderJugador.jsx
// Cabecera común del celular del jugador: avatar, nickname, puntos y salir.
// Los puntos son un odómetro animado (cuentan hacia el nuevo valor) y cada
// cambio vuela un delta (+100 verde / -50 rojo).

import React, { useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import AvatarChip from './AvatarChip';
import NumeroAnimado from './NumeroAnimado';

function PuntosConDelta({ puntos }) {
  const valor = puntos ?? 0;
  const previoRef = useRef(valor);
  const [delta, setDelta] = useState(null);

  useEffect(() => {
    const previo = previoRef.current;
    if (!Number.isFinite(valor) || valor === previo) return;
    previoRef.current = valor;
    setDelta({ cambio: valor - previo, clave: Date.now() });
  }, [valor]);

  useEffect(() => {
    if (!delta) return undefined;
    const t = setTimeout(() => setDelta(null), 1250);
    return () => clearTimeout(t);
  }, [delta?.clave]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="relative text-right">
      <p className="text-xl font-black tabular-nums text-amber-300 leading-none">
        <NumeroAnimado valor={valor} />
        <span className="text-[10px] font-bold text-[#8B80B3] ml-1">PTS</span>
      </p>
      {delta && (
        <span
          key={delta.clave}
          className={`animate-flotar-arriba absolute -top-2 right-0 text-sm font-black tabular-nums ${
            delta.cambio > 0 ? 'text-green-400' : 'text-red-400'
          }`}
        >
          {delta.cambio > 0 ? `+${delta.cambio}` : delta.cambio}
        </span>
      )}
    </div>
  );
}

export default function HeaderJugador({ sesion, jugador, puntos, racha, onSalir }) {
  return (
    <header className="flex items-center justify-between gap-3 w-full">
      <div className="flex items-center gap-3 min-w-0">
        <AvatarChip icono={jugador?.icono} color={jugador?.color} tamano="md" online />
        <div className="min-w-0">
          <p className="text-sm font-bold truncate font-display">{jugador?.nickname || sesion?.nickname}</p>
          <p className="text-[10px] uppercase tracking-wider text-[#8B80B3]">
            Sala {sesion?.codigo}
          </p>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex flex-col items-end">
          <PuntosConDelta puntos={puntos} />
          {racha > 0 && <p className="text-[11px] font-bold text-orange-300 mt-0.5">racha {racha} 🔥</p>}
        </div>
        <button
          onClick={onSalir}
          title="Salir de la sala"
          className="text-[#8B80B3] hover:text-white transition p-1"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
