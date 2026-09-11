// src/pages/admin/paneles/PanelRosco.jsx
//
// Proyección + control del ROSCO INDIVIDUAL:
//   * Reloj TOTAL de la partida (todos corren la misma ventana).
//   * Tarjetas por jugador: letra actual, aciertos/errores/pasapalabras y
//     si ya terminaron su rosco. Se alimenta de `jugadores.rosco` en vivo.
//   * El anfitrión controla Pausar/Reanudar/Terminar (barra superior).

import React from 'react';
import { Check, X, SkipForward, PartyPopper } from 'lucide-react';
import AnilloProgreso from '../../../components/AnilloProgreso';
import AvatarChip from '../../../components/AvatarChip';
import RankingJugadores from '../../../components/RankingJugadores';
import FeedBurbujas from '../../../components/FeedBurbujas';
import { useFeedBurbujas } from '../../../hooks/useFeedBurbujas';
import { useCuentaAtras, formatearMs } from '../../../hooks/useCuentaAtras';
import { useEventoSala } from '../../../hooks/useSalaRealtime';
import { ROSCO } from '../../../game/constantes';

export default function PanelRosco({ sala, jugadores, online, offsetReloj, escuchar }) {
  const juego = sala.juego || {};
  const congelada = sala.estado === 'pausado';
  const { burbujas, push } = useFeedBurbujas();

  // Respuestas voladas de los celulares (broadcast): burbuja por acción.
  useEventoSala(escuchar, 'rosco_resp', ({ nickname, letra, correcta }) => {
    push({
      texto: nickname || 'Jugador',
      nota: `${letra} ${correcta ? '✓' : '✗'}`,
      bien: correcta,
    });
  });

  const { msRestantes, progreso } = useCuentaAtras({
    fin: juego.inicio
      ? new Date(new Date(juego.inicio).getTime() + (juego.duracion_ms || ROSCO.SEGUNDOS_DEFECTO * 1000)).toISOString()
      : null,
    duracionMs: juego.duracion_ms || ROSCO.SEGUNDOS_DEFECTO * 1000,
    offsetReloj,
    congelada,
  });

  const resumenPorJugador = jugadores.map((j) => {
    const e = j.rosco?.e || {};
    const valores = Object.values(e);
    return {
      j,
      letra: j.rosco?.l || null,
      aciertos: valores.filter((v) => v === 1).length,
      errores: valores.filter((v) => v === 2).length,
      pasapalabras: valores.filter((v) => v === 3).length,
      terminado: Boolean(j.rosco?.t),
    };
  });
  const terminados = resumenPorJugador.filter((r) => r.terminado).length;

  const tiempoTexto = formatearMs(msRestantes, true).replace(/^0:/, '');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 flex-1">
      <FeedBurbujas burbujas={burbujas} />
      <div className="flex flex-col gap-5 min-w-0">
        {/* Reloj total */}
        <div className="flex items-center gap-5 rounded-3xl border border-white/10 bg-white/[0.04] p-5">
          <div className={msRestantes <= 15000 && msRestantes > 0 ? 'animate-pulso-reloj' : ''}>
            <AnilloProgreso
              progreso={progreso}
              tamano={120}
              grosor={10}
              texto={tiempoTexto}
              subtexto="total"
            />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xl font-black">Rosco en curso</p>
            <p className="text-sm text-[#B8AFD9] mt-1">
              {terminados} de {jugadores.length} terminaron su rosco
            </p>
            <p className="text-xs text-[#6C6193] mt-0.5">
              +100 acierto · -50 error · pasapalabra queda pendiente y vuelve en el ciclo
            </p>
          </div>
          {congelada && (
            <span className="rounded-full bg-amber-400/15 border border-amber-400/40 px-4 py-1.5 text-xs font-black text-amber-300">
              PAUSA
            </span>
          )}
        </div>

        {/* Progreso por jugador */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {resumenPorJugador.map(({ j, letra, aciertos, errores, pasapalabras, terminado }) => (
            <div
              key={j.id}
              className={`rounded-2xl border p-4 ${
                terminado
                  ? 'border-amber-400/40 bg-amber-400/[0.07]'
                  : 'border-white/10 bg-white/[0.04]'
              }`}
            >
              <div className="flex items-center gap-2.5 mb-3">
                <AvatarChip icono={j.icono} color={j.color} tamano="sm" online={online?.has(j.id)} />
                <span className="text-sm font-bold truncate flex-1">{j.nickname}</span>
                {terminado ? (
                  <PartyPopper size={15} className="text-amber-300 shrink-0" />
                ) : (
                  <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-400/15 text-lg font-black text-amber-300 shrink-0">
                    {letra || '—'}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-3 text-xs font-bold">
                <span className="flex items-center gap-1 text-green-300">
                  <Check size={12} /> {aciertos}
                </span>
                <span className="flex items-center gap-1 text-red-300">
                  <X size={12} /> {errores}
                </span>
                <span className="flex items-center gap-1 text-yellow-300">
                  <SkipForward size={12} /> {pasapalabras}
                </span>
                {terminado && (
                  <span className="ml-auto text-[10px] uppercase tracking-wider text-amber-300 font-black">
                    {tiempoAgotadoLabel(msRestantes)}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
          Ranking en vivo
        </h2>
        <RankingJugadores jugadores={jugadores} online={online} compacto />
      </div>
    </div>
  );
}

function tiempoAgotadoLabel(msRestantes) {
  return msRestantes <= 0 ? 'TIEMPO AGOTADO' : 'COMPLETO';
}
