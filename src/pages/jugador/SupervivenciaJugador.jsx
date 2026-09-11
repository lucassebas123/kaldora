// src/pages/jugador/SupervivenciaJugador.jsx
//
// SUPERVIVENCIA: Verdadero / Falso a eliminación súbita.
//   * Un error (o quedarse sin responder en la ventana) elimina.
//   * El eliminado pasa a espectador: pantalla teñida de rojo, ve la partida.
//   * Los vivos suman +25 por acierto; el servidor procesa y audita todo.
//
// La vista muta con salas.juego (pregunta_id, inicio, duracion_ms, ronda).

import React, { useEffect, useRef, useState } from 'react';
import { Check, X, Skull, Eye } from 'lucide-react';
import { useCuentaAtras, calcularFin, formatearMs } from '../../hooks/useCuentaAtras';
import { api, consultas } from '../../api/kaldoraApi';
import { SUPERVIVENCIA } from '../../game/constantes';
import { sonarAcierto, sonarFallo, sonarTicTac } from '../../utils/sonidos';
import { vibrarExito, vibrarFallo, vibrarEliminado } from '../../utils/haptico';
import FlashEvento from '../../components/FlashEvento';
import { SkeletonLineas } from '../../components/Skeleton';

export default function SupervivenciaJugador({
  sala,
  jugadores,
  sesion,
  jugadorPropio,
  offsetReloj,
  enviar,
}) {
  const juego = sala.juego || {};
  const idPregunta = juego.pregunta_id || null;
  const congelada = sala.estado === 'pausado';

  const [pregunta, setPregunta] = useState(null);
  const [respuestaEnviada, setRespuestaEnviada] = useState(null); // {correcta, eliminado}
  const [enviando, setEnviando] = useState(false);
  const [eliminado, setEliminado] = useState(false);
  const [velo, setVelo] = useState(null);
  const procesadoRef = useRef(null);

  const vivos = jugadores.filter((j) => !j.eliminado);

  // Estado eliminado: primero por RPC (instantáneo), confirmado por Realtime.
  useEffect(() => {
    if (jugadorPropio?.eliminado) setEliminado(true);
  }, [jugadorPropio?.eliminado]);

  // Reset por ronda.
  useEffect(() => {
    setRespuestaEnviada(null);
    setPregunta(null);
    if (!idPregunta) return;
    let vigente = true;
    consultas
      .preguntaSupervivenciaPorId(idPregunta)
      .then((p) => vigente && setPregunta(p))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [idPregunta]);

  const { msRestantes, progreso } = useCuentaAtras({
    fin: calcularFin(juego.inicio, juego.duracion_ms || SUPERVIVENCIA.DURACION_MS),
    duracionMs: juego.duracion_ms || SUPERVIVENCIA.DURACION_MS,
    offsetReloj,
    congelada,
  });

  // Tic-tac final.
  useEffect(() => {
    if (congelada || eliminado) return;
    if (msRestantes > 0 && msRestantes <= 3000) sonarTicTac();
  }, [Math.ceil(msRestantes / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Fin de ventana: procesar eliminados por timeout contra el DEADLINE real
  // (idempotente en el servidor; cualquier cliente puede dispararlo).
  useEffect(() => {
    if (congelada || !idPregunta || !juego.inicio) return undefined;
    const finMs =
      new Date(juego.inicio).getTime() + (juego.duracion_ms || SUPERVIVENCIA.DURACION_MS) + 400 - offsetReloj;
    const ms = finMs - Date.now();
    if (ms <= 0) {
      if (procesadoRef.current !== idPregunta) {
        procesadoRef.current = idPregunta;
        api.supervivenciaProcesar(sala.id, idPregunta).catch(() => {});
      }
      return undefined;
    }
    const pid = setTimeout(() => {
      if (procesadoRef.current !== idPregunta) {
        procesadoRef.current = idPregunta;
        api.supervivenciaProcesar(sala.id, idPregunta).catch(() => {});
      }
    }, ms);
    return () => clearTimeout(pid);
  }, [idPregunta, juego.inicio, juego.duracion_ms, congelada, offsetReloj, sala.id]);

  async function responder(valor) {
    if (respuestaEnviada || enviando || congelada || eliminado || msRestantes <= 0) return;
    setEnviando(true);
    try {
      const res = await api.supervivenciaResponder(valor);
      setRespuestaEnviada(res);
      if (res.correcta) {
        sonarAcierto();
        vibrarExito();
        setVelo({ tipo: 'acierto', clave: Date.now() });
      } else {
        sonarFallo();
        vibrarFallo();
        setVelo({ tipo: 'fallo', clave: Date.now() });
        if (res.eliminado) {
          setTimeout(() => {
            setEliminado(true);
            vibrarEliminado();
          }, 900);
        }
      }

      enviar('superv_resp', { jugador: sesion.idJugador, idPregunta });
    } catch (err) {
      if (String(err.message).includes('Ya respondiste')) {
        setRespuestaEnviada({ correcta: null });
      }
    } finally {
      setEnviando(false);
    }
  }

  const tiempoTexto = formatearMs(msRestantes, true).replace('0:', '');
  const tiempoAgotado = msRestantes <= 0 && !congelada;

  // ---------------------------------------------------------------------------
  // Espectador (eliminado)
  // ---------------------------------------------------------------------------
  if (eliminado) {
    return (
      <div className="flex flex-col gap-4 flex-1 relative">
        <div className="pointer-events-none fixed inset-0 z-30 bg-red-600/10 animate-pulso-rojo" />
        <div className="rounded-2xl border border-red-500/50 bg-red-500/15 p-5 text-center animate-pop">
          <Skull className="mx-auto text-red-400 mb-2" size={34} />
          <p className="text-lg font-black text-red-300">ELIMINADO</p>
          <p className="text-xs text-red-200/80 mt-1">
            Un error y afuera. Ahora sos espectador de la partida.
          </p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center">
          <p className="flex items-center justify-center gap-2 text-xs uppercase tracking-wider text-[#8B80B3] font-bold">
            <Eye size={13} /> Ronda {juego.ronda ?? 1}
          </p>
          <p className="text-sm text-[#B8AFD9] mt-1">{pregunta?.pregunta || '...'}</p>
        </div>

        <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 text-center">
          <p className="text-xs uppercase tracking-wider text-[#8B80B3] font-bold mb-1">
            Sobrevivientes
          </p>
          <p className="text-2xl font-black text-green-400">
            {vivos.length} <span className="text-sm text-[#B8AFD9]">de {jugadores.length}</span>
          </p>
          <div className="flex flex-wrap justify-center gap-1.5 mt-2">
            {vivos.slice(0, 12).map((j) => (
              <span key={j.id} className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-bold">
                {j.nickname}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Jugador vivo
  // ---------------------------------------------------------------------------
  return (
    <div className="flex flex-col gap-4 flex-1">
      <FlashEvento tipo={velo?.tipo} clave={velo?.clave} />
      {/* Estado + tiempo */}
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1.5 rounded-full bg-green-500/15 border border-green-400/30 px-3 py-1 text-xs font-black text-green-300">
          <Check size={13} /> VIVO
        </span>
        <span className="text-xs text-[#8B80B3]">
          {vivos.length} sobrevivientes de {jugadores.length}
        </span>
        <span
          className={`ml-auto text-2xl font-black tabular-nums font-display ${
            tiempoAgotado ? 'text-red-400' : msRestantes < 3000 ? 'text-orange-300 animate-pulso-reloj' : 'text-white'
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

      {/* Barra de tiempo */}
      <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
        <div
          className={`h-full ${msRestantes < 3000 ? 'bg-red-400' : 'bg-gradient-to-r from-red-500 to-rose-400'}`}
          style={{ width: `${progreso * 100}%` }}
        />
      </div>

      {/* Pregunta */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-center">
        {pregunta ? (
          <p className="text-lg font-semibold leading-snug">{pregunta.pregunta}</p>
        ) : (
          <SkeletonLineas lineas={2} className="mx-auto max-w-sm py-1" />
        )}
      </div>

      {/* Botones V / F */}
      <div className="grid grid-cols-2 gap-3 mt-1">
        <button
          type="button"
          onClick={() => responder(true)}
          disabled={Boolean(respuestaEnviada) || enviando || tiempoAgotado || congelada || !pregunta}
          className="h-24 rounded-2xl bg-gradient-to-br from-green-500 to-emerald-600 text-white font-black text-xl flex flex-col items-center justify-center gap-1 shadow-lg shadow-green-500/20 hover:brightness-110 active:scale-95 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <Check size={26} />
          VERDADERO
        </button>
        <button
          type="button"
          onClick={() => responder(false)}
          disabled={Boolean(respuestaEnviada) || enviando || tiempoAgotado || congelada || !pregunta}
          className="h-24 rounded-2xl bg-gradient-to-br from-red-500 to-rose-600 text-white font-black text-xl flex flex-col items-center justify-center gap-1 shadow-lg shadow-red-500/20 hover:brightness-110 active:scale-95 transition disabled:opacity-30 disabled:cursor-not-allowed"
        >
          <X size={26} />
          FALSO
        </button>
      </div>

      {/* Feedback */}
      {respuestaEnviada && respuestaEnviada.correcta !== null && (
        <div
          className={`rounded-2xl px-4 py-3 text-center font-extrabold animate-pop ${
            respuestaEnviada.correcta
              ? 'bg-green-500/15 border border-green-400/40 text-green-300'
              : 'bg-red-500/20 border border-red-400/50 text-red-300'
          }`}
        >
          {respuestaEnviada.correcta
            ? `¡Sobrevivís! +${SUPERVIVENCIA.PUNTOS_ACIERTO} pts`
            : 'Fallaste... quedás eliminado'}
        </div>
      )}
      {tiempoAgotado && !respuestaEnviada && !congelada && (
        <div className="rounded-2xl border border-red-400/40 bg-red-400/10 px-4 py-3 text-center text-sm font-bold text-red-300 animate-pulse">
          ¡No respondiste! Procesando eliminados...
        </div>
      )}
    </div>
  );
}
