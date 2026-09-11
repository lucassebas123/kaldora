// src/components/RankingJugadores.jsx
//
// Tabla de posiciones en vivo (solo columnas públicas de 'jugadores':
// nickname, avatar, puntos, racha, eliminado — jamás datos privados).

import React from 'react';
import AvatarChip from './AvatarChip';
import { Skull } from 'lucide-react';

const MEDALLAS = ['🥇', '🥈', '🥉'];

export default function RankingJugadores({
  jugadores = [],
  idJugadorPropio = null,
  online = null,
  compacto = false,
  mostrarRacha = false,
}) {
  if (jugadores.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-6 text-center text-sm text-[#B8AFD9]">
        Todavía no hay jugadores. ¡Compartí el PIN!
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden">
      <div
        className={`grid gap-2 px-4 ${
          mostrarRacha ? 'grid-cols-[2.5rem_1fr_4rem_3.5rem]' : 'grid-cols-[2.5rem_1fr_4rem]'
        } py-2 text-[10px] font-bold uppercase tracking-wider text-[#8B80B3] border-b border-white/10`}
      >
        <span>#</span>
        <span>Jugador</span>
        <span className="text-right">Puntos</span>
        {mostrarRacha && <span className="text-right">Racha</span>}
      </div>

      <ul>
        {jugadores.map((j, i) => {
          const propio = j.id === idJugadorPropio;
          return (
            <li
              key={j.id}
              className={`grid items-center gap-2 px-4 ${
                mostrarRacha ? 'grid-cols-[2.5rem_1fr_4rem_3.5rem]' : 'grid-cols-[2.5rem_1fr_4rem]'
              } ${
                compacto ? 'py-2' : 'py-2.5'
              } border-b border-white/5 last:border-b-0 ${
                propio ? 'bg-fuchsia-500/10' : ''
              } ${j.eliminado ? 'opacity-40' : ''}`}
            >
              <span className="font-bold text-amber-300 text-sm">
                {MEDALLAS[i] || `${i + 1}º`}
              </span>

              <span className="flex items-center gap-2.5 min-w-0">
                <AvatarChip
                  icono={j.icono}
                  color={j.color}
                  tamano={compacto ? 'sm' : 'md'}
                  online={online ? online.has(j.id) : null}
                />
                <span className={`truncate text-sm font-semibold ${propio ? 'text-fuchsia-200' : 'text-white'}`}>
                  {j.nickname}
                </span>
                {j.eliminado && <Skull size={14} className="text-red-400 shrink-0" />}
              </span>

              <span className="text-right text-sm font-extrabold tabular-nums text-white">
                {j.puntos ?? 0}
              </span>

              {mostrarRacha && (
                <span className="text-right text-xs font-bold tabular-nums text-orange-300">
                  {j.racha > 0 ? `${j.racha}🔥` : '—'}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
