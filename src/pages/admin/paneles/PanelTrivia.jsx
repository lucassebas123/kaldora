// src/pages/admin/paneles/PanelTrivia.jsx
//
// Proyección + control de la TRIVIA DE VELOCIDAD: la pregunta con sus
// opciones y la correcta resaltada (solo el host ve el índice), el reloj
// de 20 s que se derrite, contador en vivo de respuestas y el botón para
// lanzar la siguiente pregunta.

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, SkipForward } from 'lucide-react';
import RankingJugadores from '../../../components/RankingJugadores';
import FeedBurbujas, { useFeedBurbujas } from '../../../components/FeedBurbujas';
import { SkeletonLineas } from '../../../components/Skeleton';
import { useCuentaAtras, calcularFin, formatearMs } from '../../../hooks/useCuentaAtras';
import { useEventoSala } from '../../../hooks/useSalaRealtime';
import { api, consultas } from '../../../api/kaldoraApi';
import { TRIVIA } from '../../../game/constantes';

const LETRAS_OPCION = ['A', 'B', 'C', 'D'];

export default function PanelTrivia({
  sala, jugadores, online, offsetReloj, escuchar, enviar, ejecutar, trabajando,
}) {
  const juego = sala.juego || {};
  const congelada = sala.estado === 'pausado';
  const { burbujas, push } = useFeedBurbujas();

  const [pregunta, setPregunta] = useState(null);
  const [respondieron, setRespondieron] = useState(0);
  const [acertaron, setAcertaron] = useState(0);
  const reveladoRef = useRef(null);

  // Pregunta activa, con la correcta resaltada (columna solo del host).
  useEffect(() => {
    setRespondieron(0);
    setAcertaron(0);
    reveladoRef.current = null;
    if (!juego.pregunta_id) {
      setPregunta(null);
      return;
    }
    let vigente = true;
    consultas
      .preguntaTriviaConRespuesta(juego.pregunta_id)
      .then((p) => vigente && setPregunta(p))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [juego.pregunta_id]);

  const { msRestantes, progreso } = useCuentaAtras({
    fin: calcularFin(juego.inicio, juego.duracion_ms || TRIVIA.DURACION_MS),
    duracionMs: juego.duracion_ms || TRIVIA.DURACION_MS,
    offsetReloj,
    congelada,
  });

  // Contador en vivo vía broadcast (+ burbuja con el nombre).
  useEventoSala(escuchar, 'trivia_resp', ({ nickname, correcta, puntos }) => {
    setRespondieron((n) => n + 1);
    if (correcta) setAcertaron((n) => n + 1);
    push({
      texto: nickname || 'Jugador',
      nota: correcta ? `+${puntos ?? '?'}` : '✗',
      bien: correcta,
    });
  });

  // Al agotarse el tiempo, revela la correcta en los celulares (broadcast).
  useEffect(() => {
    if (congelada || !pregunta) return;
    if (msRestantes > 0) return;
    if (reveladoRef.current === juego.pregunta_id) return;
    reveladoRef.current = juego.pregunta_id;
    enviar('trivia_reveal', { indice: pregunta.indice_correcto });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [msRestantes <= 0, congelada, pregunta?.id]);

  const tiempoTexto = formatearMs(msRestantes, true).replace('0:', '');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 flex-1">
      <FeedBurbujas burbujas={burbujas} />
      <div className="flex flex-col gap-5 min-w-0">
        {/* Reloj */}
        <div className="flex items-center gap-4">
          <span
            className={`text-6xl font-black tabular-nums font-display ${
              msRestantes <= 3000 ? 'text-red-400 animate-pulso-reloj' : 'text-sky-300'
            }`}
          >
            <span
              key={Math.ceil(msRestantes / 1000)}
              className={`inline-block ${msRestantes > 0 && msRestantes <= 5000 ? 'animate-tic' : ''}`}
            >
              {tiempoTexto}
            </span>
          </span>
          <div className="flex-1 h-4 rounded-full bg-white/10 overflow-hidden">
            <div
              className={`h-full ${msRestantes <= 3000 ? 'bg-red-400' : 'bg-gradient-to-r from-sky-400 to-cyan-400'}`}
              style={{ width: `${progreso * 100}%` }}
            />
          </div>
          <span className="rounded-full bg-white/10 px-3 py-1 text-xs font-black uppercase tracking-wider text-[#B8AFD9]">
            Ronda {juego.ronda ?? 1}
          </span>
        </div>

        {/* Pregunta + opciones con la correcta resaltada */}
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6">
          {pregunta?.pregunta ? (
            <p className="text-2xl font-semibold leading-snug text-center">{pregunta.pregunta}</p>
          ) : (
            <SkeletonLineas lineas={2} className="mx-auto max-w-md py-1" />
          )}

          <div className="mt-5 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(pregunta?.opciones || []).map((opcion, i) => {
              const correcta = pregunta && i === pregunta.indice_correcto;
              return (
                <div
                  key={i}
                  className={`flex items-center gap-3 rounded-xl border px-4 py-3 font-semibold ${
                    correcta
                      ? 'border-green-400/60 bg-green-400/15 text-green-200'
                      : 'border-white/10 bg-white/[0.03] text-white/80'
                  }`}
                >
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-sm font-black">
                    {LETRAS_OPCION[i]}
                  </span>
                  {opcion}
                  {correcta && <span className="ml-auto text-xs font-black text-green-400">✓ CORRECTA</span>}
                </div>
              );
            })}
          </div>
        </div>

        {/* Contadores en vivo */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-center">
            <p className="text-xs uppercase tracking-wider text-[#8B80B3] font-bold">Respondieron</p>
            <p className="text-2xl font-black tabular-nums text-sky-300 mt-1">
              {respondieron}
              <span className="text-sm text-[#8B80B3]"> / {jugadores.length}</span>
            </p>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-center">
            <p className="text-xs uppercase tracking-wider text-[#8B80B3] font-bold">Acertaron</p>
            <p className="text-2xl font-black tabular-nums text-green-300 mt-1">{acertaron}</p>
          </div>
        </div>

        <button
          onClick={() => ejecutar(() => api.triviaSiguiente(sala.id))}
          disabled={trabajando || congelada}
          className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-sky-400 to-cyan-500 text-[#1B1035] font-black text-lg px-10 py-4 shadow-lg shadow-sky-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {trabajando ? <Loader2 className="animate-spin" size={20} /> : <SkipForward size={20} />}
          Siguiente pregunta
        </button>
      </div>

      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
          Ranking (rachas 🔥)
        </h2>
        <RankingJugadores jugadores={jugadores} online={online} compacto mostrarRacha />
      </div>
    </div>
  );
}
