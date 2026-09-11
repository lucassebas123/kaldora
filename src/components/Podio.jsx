// src/components/Podio.jsx
//
// Vista de partida finalizada para jugador y anfitrión: podio escalonado
// (3º → 2º → 1º) + ranking completo + espera de revancha. La celebración
// (confeti en capas, fanfarria y vibración) corre UNA vez por montaje de la
// vista (antes se reiniciaba con cada snapshot del polling: lluvia infinita).

import React, { useEffect, useRef, useState } from 'react';
import RankingJugadores from './RankingJugadores';
import AvatarChip from './AvatarChip';
import ConfetiCSS from './ConfetiCSS';
import { celebracionPodio, confetiGoteo } from '../utils/confeti';
import { sonarVictoria } from '../utils/sonidos';
import { vibrarVictoria } from '../utils/haptico';

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
  const gane = Boolean(idJugadorPropio && jugadores[0]?.id === idJugadorPropio);
  const ganeRef = useRef(gane);
  useEffect(() => {
    ganeRef.current = gane;
  }, [gane]);
  const [mostrados, setMostrados] = useState(0); // 0..3 escalones revelados

  useEffect(() => {
    // Celebración: secuencia en capas + goteo para quien mira tarde.
    const pararCelebracion = celebracionPodio({ gano: Boolean(ganeRef.current) });
    const pararGoteo = confetiGoteo({ duracionMs: 14000 });
    sonarVictoria();
    vibrarVictoria();

    // Escalones escalonados: 3º, 2º y por último 1º (corona incluida).
    const t1 = setTimeout(() => setMostrados(1), 350);
    const t2 = setTimeout(() => setMostrados(2), 1150);
    const t3 = setTimeout(() => setMostrados(3), 2100);

    return () => {
      pararCelebracion();
      pararGoteo();
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
    <div className="relative w-full max-w-lg mx-auto flex flex-col items-center gap-6">
      <ConfetiCSS />

      {/* Foco giratorio detrás del podio (rayos de luz del ganador). */}
      <div className="pointer-events-none absolute -top-28 left-1/2 -z-10 h-[34rem] w-[34rem] -translate-x-1/2 opacity-40">
        <div
          className="animate-girar-lento h-full w-full rounded-full"
          style={{
            background:
              'conic-gradient(from 0deg, transparent 0deg, rgba(242,183,5,0.4) 18deg, transparent 40deg, rgba(217,70,239,0.3) 95deg, transparent 115deg, rgba(56,189,248,0.3) 180deg, transparent 205deg, rgba(242,183,5,0.4) 260deg, transparent 285deg, rgba(217,70,239,0.3) 340deg, transparent 360deg)',
            filter: 'blur(2px)',
          }}
        />
      </div>

      <div className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.3em] text-[#8B80B3] font-display">{titulo}</p>
        <h1
          className={`mt-2 text-3xl sm:text-4xl font-black font-display ${
            propioGano
              ? 'animate-latido bg-gradient-to-r from-amber-200 via-yellow-400 to-amber-200 bg-clip-text text-transparent'
              : 'text-white'
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
            // Revela 3º → 2º → 1º (el 1º cae junto con la corona y su brillo).
            const visible = mostrados >= 3 - puesto;
            return (
              <div key={i} className="flex flex-col items-center justify-end w-24">
                {visible && j ? (
                  <div className="flex flex-col items-center gap-1 animate-pop mb-2">
                    {puesto === 0 && <span className="text-2xl leading-none animate-float">👑</span>}
                    <span className="text-2xl">{PODIO_MEDALLAS[puesto]}</span>
                    <AvatarChip icono={j.icono} color={j.color} tamano="md" online={online?.has(j.id)} />
                    <p
                      className={`text-xs font-black truncate max-w-24 font-display ${
                        puesto === 0
                          ? 'bg-gradient-to-r from-amber-200 via-yellow-300 to-amber-200 bg-clip-text text-transparent'
                          : 'text-white'
                      }`}
                    >
                      {j.nickname}
                    </p>
                    <p className="text-[10px] font-bold tabular-nums text-[#B8AFD9]">{j.puntos} pts</p>
                  </div>
                ) : (
                  <div className="mb-2 h-28" />
                )}
                <div
                  className={`w-full origin-bottom rounded-t-xl border-t border-x bg-gradient-to-b ${
                    PODIO_TONOS[puesto]
                  } ${PODIO_ALTURAS[puesto]} transition-all duration-700 ${
                    visible ? 'opacity-100 scale-y-100' : 'opacity-0 scale-y-0'
                  } ${puesto === 0 ? 'shadow-[0_0_45px_rgba(242,183,5,0.4)]' : ''} flex items-start justify-center pt-1.5`}
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
