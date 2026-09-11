// src/pages/admin/paneles/PanelSupervivencia.jsx
//
// Control de SUPERVIVENCIA: pregunta con su verdad (solo host), reloj de la
// ronda, contador de respuestas en vivo (broadcast), vivos vs eliminados y
// avance de ronda. Cuando queda un solo vivo, sugiere terminar.

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, SkipForward, Skull, HeartPulse } from 'lucide-react';
import RankingJugadores from '../../../components/RankingJugadores';
import FeedBurbujas, { useFeedBurbujas } from '../../../components/FeedBurbujas';
import { SkeletonLineas } from '../../../components/Skeleton';
import { useCuentaAtras, calcularFin, formatearMs } from '../../../hooks/useCuentaAtras';
import { useEventoSala } from '../../../hooks/useSalaRealtime';
import { api, consultas } from '../../../api/kaldoraApi';
import { SUPERVIVENCIA } from '../../../game/constantes';

export default function PanelSupervivencia({
  sala, jugadores, online, offsetReloj, escuchar, ejecutar, trabajando,
}) {
  const juego = sala.juego || {};
  const idPregunta = juego.pregunta_id;
  const congelada = sala.estado === 'pausado';
  const { burbujas, push } = useFeedBurbujas();

  const [pregunta, setPregunta] = useState(null);
  const [respondieron, setRespondieron] = useState(0);
  // Evita re-procesar la misma pregunta con cada cambio de offsetReloj.
  const procesadoRef = useRef(null);

  const vivos = jugadores.filter((j) => !j.eliminado);
  const eliminados = jugadores.filter((j) => j.eliminado);
  const nicknamePorId = Object.fromEntries(jugadores.map((j) => [j.id, j.nickname]));

  // Pregunta activa, con su verdad (columna solo del host).
  useEffect(() => {
    setRespondieron(0);
    if (!idPregunta) {
      setPregunta(null);
      return;
    }
    let vigente = true;
    consultas
      .preguntaSupervivenciaConRespuesta(idPregunta)
      .then((p) => vigente && setPregunta(p))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [idPregunta]);

  const { msRestantes } = useCuentaAtras({
    fin: calcularFin(juego.inicio, juego.duracion_ms || SUPERVIVENCIA.DURACION_MS),
    duracionMs: juego.duracion_ms || SUPERVIVENCIA.DURACION_MS,
    offsetReloj,
    congelada,
  });

  // Contador de respuestas en vivo (cada jugador avisa por broadcast).
  useEventoSala(escuchar, 'superv_resp', ({ idJugador }) => {
    setRespondieron((n) => n + 1);
    push({ texto: nicknamePorId[idJugador] || 'Jugador', nota: 'V/F' });
  });

  // Fin de ventana: procesar eliminados contra el DEADLINE real (una sola vez
  // por pregunta; el servidor igual es idempotente).
  useEffect(() => {
    if (congelada || !idPregunta || !juego.inicio) return undefined;
    const disparar = () => {
      if (procesadoRef.current === idPregunta) return;
      procesadoRef.current = idPregunta;
      ejecutar(() => api.supervivenciaProcesar(sala.id, idPregunta));
    };
    const finMs =
      new Date(juego.inicio).getTime() + (juego.duracion_ms || SUPERVIVENCIA.DURACION_MS) + 400 - offsetReloj;
    const ms = finMs - Date.now();
    if (ms <= 0) {
      disparar();
      return undefined;
    }
    const pid = setTimeout(disparar, ms);
    return () => clearTimeout(pid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idPregunta, juego.inicio, juego.duracion_ms, congelada, offsetReloj]);

  const tiempoTexto = formatearMs(msRestantes, true).replace('0:', '');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 flex-1">
      <FeedBurbujas burbujas={burbujas} />
      <div className="flex flex-col gap-5 min-w-0">
        {/* Estado */}
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 rounded-full bg-green-500/15 border border-green-400/30 px-4 py-1.5 text-sm font-black text-green-300">
            <HeartPulse size={15} /> {vivos.length} vivos
          </span>
          <span className="flex items-center gap-1.5 rounded-full bg-red-500/15 border border-red-400/30 px-4 py-1.5 text-sm font-black text-red-300">
            <Skull size={15} /> {eliminados.length} eliminados
          </span>
          <span
            className={`ml-auto text-5xl font-black tabular-nums font-display ${
              msRestantes <= 3000 ? 'text-red-400 animate-pulso-reloj' : 'text-white'
            }`}
          >
            <span
              key={Math.ceil(msRestantes / 1000)}
              className={`inline-block ${msRestantes > 0 && msRestantes <= 3000 ? 'animate-tic' : ''}`}
            >
              {tiempoTexto}
            </span>
          </span>
        </div>

        {/* Pregunta */}
        <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center">
          <p className="text-[10px] uppercase tracking-widest text-[#8B80B3] font-bold mb-2">
            Ronda {juego.ronda ?? 1} · respondieron {respondieron}/{vivos.length}
          </p>
          {pregunta?.pregunta ? (
            <p className="text-2xl font-semibold leading-snug">{pregunta.pregunta}</p>
          ) : (
            <SkeletonLineas lineas={2} className="mx-auto max-w-md py-1" />
          )}
          {pregunta && (
            <p
              className={`mt-3 inline-block rounded-full px-4 py-1 text-sm font-black ${
                pregunta.es_verdadera
                  ? 'bg-green-500/20 text-green-300'
                  : 'bg-red-500/20 text-red-300'
              }`}
            >
              Verdad: {pregunta.es_verdadera ? 'VERDADERO' : 'FALSO'}
            </p>
          )}
        </div>

        {/* Proyección de eliminados en vivo */}
        {eliminados.length > 0 && (
          <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-4">
            <p className="text-[10px] uppercase tracking-widest text-red-300 font-bold mb-2">
              Últimas bajas
            </p>
            <div className="flex flex-wrap gap-2">
              {eliminados.slice(-14).map((j) => (
                <span
                  key={j.id}
                  className="flex items-center gap-1.5 rounded-full bg-red-500/15 px-3 py-1 text-xs font-bold text-red-200"
                >
                  <Skull size={11} /> {j.nickname}
                </span>
              ))}
            </div>
          </div>
        )}

        <button
          onClick={() => ejecutar(() => api.supervivenciaSiguiente(sala.id))}
          disabled={trabajando || congelada}
          className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-red-500 to-rose-600 text-white font-black text-lg px-10 py-4 shadow-lg shadow-red-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40"
        >
          {trabajando ? <Loader2 className="animate-spin" size={20} /> : <SkipForward size={20} />}
          Siguiente ronda
        </button>

        {vivos.length <= 1 && (
          <p className="text-center text-sm font-bold text-amber-300 animate-pulse">
            ¡Queda {vivos.length === 1 ? `un sobreviviente (${vivos[0]?.nickname})` : 'nadie vivo'}! Usá
            "Terminar" arriba para el podio.
          </p>
        )}
      </div>

      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
          Ranking (💀 = eliminado)
        </h2>
        <RankingJugadores jugadores={jugadores} online={online} compacto />
      </div>
    </div>
  );
}
