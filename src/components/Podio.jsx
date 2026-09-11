// src/components/Podio.jsx
//
// Vista de partida finalizada para jugador y anfitrión: podio escalonado
// (3º → 2º → 1º, con confeti por escalón) + ranking completo + estado de
// espera a la revancha. El confeti corre UNA vez por montaje de la vista
// (antes se reiniciaba con cada snapshot del polling: lluvia infinita).

import React, { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import RankingJugadores from './RankingJugadores';
import AvatarChip from './AvatarChip';

const PODIO_ALTURAS = ['h-24', 'h-16', 'h-12']; // 1º, 2º, 3º
const PODIO_TONOS = [
  'from-amber-400/40 to-amber-500/10 border-amber-400/50 text-amber-200',
  'from-slate-300/25 to-slate-400/5 border-slate-300/40 text-slate-200',
  'from-orange-600/25 to-orange-700/5 border-orange-600/40 text-orange-200',
];
const PODIO_MEDALLAS = ['🥇', '🥈', '🥉'];

export default function Podio({
  jugadores,
  idJugadorPropio = null,
  online = null,
  mensaje = '¡Partida finalizada!',
  titulo = 'Podio final',
}) {
  // Confeti celebratorio (más denso si el propio jugador ganó). Una sola
  // corrida: el montaje del podio marca el momento, no cada snapshot.
  const gane = idJugadorPropio && jugadores[0]?.id === idJugadorPropio;
  const ganeRef = useRef(gane);
  ganeRef.current = gane;
  const [mostrados, setMostrados] = useState(0); // 0..3 escalones revelados

  useEffect(() => {
    const lluvia = setInterval(() => {
      confetti({
        particleCount: ganeRef.current ? 110 : 70,
        spread: 80,
        startVelocity: 38,
        origin: { x: Math.random(), y: 0.1 + Math.random() * 0.3 },
        zIndex: 9999,
      });
    }, ganeRef.current ? 200 : 280);
    const fin = setTimeout(() => clearInterval(lluvia), ganeRef.current ? 4200 : 2600);

    // Escalones escalonados: 3º, 2º y por último 1º con su ráfaga.
    const t1 = setTimeout(() => setMostrados(1), 350);
    const t2 = setTimeout(() => setMostrados(2), 1150);
    const t3 = setTimeout(() => {
      setMostrados(3);
      confetti({
        particleCount: 120,
        spread: 100,
        startVelocity: 46,
      origin: { x: 0.5, y: 0.45 },
      zIndex: 9999,
    });
    }, 2100);

    return () => {
      clearInterval(lluvia);
      clearTimeout(fin);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
    // Una corrida por montaje: el podio no depende de los snapshots.
  }, []);

  const top = jugadores[0];
  const propioGano = idJugadorPropio && top?.id === idJugadorPropio;
  const escalones = jugadores.slice(0, 3); // [1º, 2º, 3º]
  const ordenVisual = [escalones[1], escalones[0], escalones[2]]; // 2º | 1º | 3º
  const ordenIdx = [1, 0, 2]; // índice del puesto para colores/alturas
  const hayPodio = escalones.length > 0;

  return (
    <div className="w-full max-w-lg mx-auto flex flex-col items-center gap-6">
      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-[#8B80B3] font-display">{titulo}</p>
        <h1
          className={`mt-2 text-3xl sm:text-4xl font-black font-display ${
            propioGano ? 'text-amber-300' : 'text-white'
          }`}
        >
          {propioGano ? '¡GANASTE! 🏆' : mensaje}
        </h1>
        {top && !propioGano && (
          <p className="mt-1 text-[#B8AFD9]">
            Ganador: <span className="font-bold text-amber-300">{top.nickname}</span> con{' '}
            <span className="font-bold">{top.puntos}</span> pts
          </p>
        )}
      </div>

      {/* Podio escalonado: 2º | 1º | 3º, revelado de a uno */}
      {hayPodio && (
        <div className="w-full flex items-end justify-center gap-3">
          {ordenVisual.map((j, i) => {
            const puesto = ordenIdx[i];
            const visible = mostrados > puesto;
            return (
              <div key={i} className="flex flex-col items-center justify-end w-24">
                {visible && j ? (
                  <div className="flex flex-col items-center gap-1 animate-pop mb-2">
                    <span className="text-2xl">{PODIO_MEDALLAS[puesto]}</span>
                    <AvatarChip icono={j.icono} color={j.color} tamano="md" online={online?.has(j.id)} />
                    <p className={`text-xs font-black truncate max-w-24 font-display ${
                      puesto === 0 ? 'text-amber-200' : 'text-white'
                    }`}>
                      {j.nickname}
                    </p>
                    <p className="text-[10px] font-bold tabular-nums text-[#B8AFD9]">{j.puntos} pts</p>
                  </div>
                ) : (
                  <div className="mb-2 h-[4.25rem]" />
                )}
                <div
                  className={`w-full rounded-t-xl border-t border-x bg-gradient-to-b ${
                    PODIO_TONOS[puesto]
                  } ${PODIO_ALTURAS[puesto]} transition-opacity duration-500 ${
                    visible ? 'opacity-100' : 'opacity-0'
                  } flex items-start justify-center pt-1.5`}
                >
                  <span className="text-sm font-black font-display">{puesto + 1}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="w-full">
        <RankingJugadores jugadores={jugadores} idJugadorPropio={idJugadorPropio} online={online} />
      </div>

      <p className="text-xs text-[#6C6193] text-center">
        Esperá a que el anfitrión lance la revancha o elija otro juego.
      </p>
    </div>
  );
}
