// src/pages/jugador/TriviaJugador.jsx
//
// TRIVIA DE VELOCIDAD: una pregunta para todos; la base de 1000 pts se
// derrite ms a ms durante 20 s (el servidor mide el tiempo y calcula el
// puntaje). Rachas de 3+ multiplican x2, de 5+ x3.
//
// El anfitrión avanza la ronda; al llegar una pregunta nueva el componente
// se reinicia solo (la fuente de verdad es salas.juego).

import React, { useEffect, useRef, useState } from 'react';
import { useCuentaAtras, calcularFin, formatearMs } from '../../hooks/useCuentaAtras';
import { api, consultas } from '../../api/kaldoraApi';
import { TRIVIA } from '../../game/constantes';
import { sonarAcierto, sonarFallo, sonarTicTac } from '../../utils/sonidos';
import { vibrarExito, vibrarFallo } from '../../utils/haptico';
import { confetiRafaga } from '../../utils/confeti';
import FlashEvento from '../../components/FlashEvento';
import { SkeletonLineas } from '../../components/Skeleton';
import { useEventoSala } from '../../hooks/useSalaRealtime';

const LETRAS_OPCION = ['A', 'B', 'C', 'D'];

export default function TriviaJugador({ sala, sesion, offsetReloj, escuchar, enviar }) {
  const juego = sala.juego || {};
  const idPregunta = juego.pregunta_id || null;
  const congelada = sala.estado === 'pausado';

  const [pregunta, setPregunta] = useState(null);
  const [respondida, setRespondida] = useState(null); // { correcta, puntos, multiplicador }
  const [enviando, setEnviando] = useState(false);
  const [indiceCorrecto, setIndiceCorrecto] = useState(null); // revelado por el host
  const [velo, setVelo] = useState(null); // { tipo, clave }
  const [combo, setCombo] = useState(null); // multiplicador de racha (x2/x3)
  const [sacudir, setSacudir] = useState(false);
  const sacudidoRef = useRef(null);
  // Clave incremental para reiniciar el velo (evita Date.now durante render,
  // que la regla de pureza marca como impuro).
  const veloClaveRef = useRef(0);

  // Pregunta activa (mismo enunciado para todos; fija en la sala).
  // El reseteo ocurre en render al cambiar la pregunta (patrón React
  // "adjusting state during render"); el efecto solo trae el enunciado.
  const [preguntaPrevia, setPreguntaPrevia] = useState(idPregunta);
  if (preguntaPrevia !== idPregunta) {
    setPreguntaPrevia(idPregunta);
    setPregunta(null);
    setRespondida(null);
    setIndiceCorrecto(null);
  }
  useEffect(() => {
    if (!idPregunta) return undefined;
    let vigente = true;
    consultas
      .preguntaTriviaPorId(idPregunta)
      .then((p) => vigente && setPregunta(p))
      .catch(() => {});
    return () => {
      vigente = false;
    };
  }, [idPregunta]);

  const { msRestantes, progreso } = useCuentaAtras({
    fin: calcularFin(juego.inicio, juego.duracion_ms || TRIVIA.DURACION_MS),
    duracionMs: juego.duracion_ms || TRIVIA.DURACION_MS,
    offsetReloj,
    congelada,
  });

  // Tic-tac de los últimos 5 segundos.
  useEffect(() => {
    if (congelada || respondida) return;
    if (msRestantes > 0 && msRestantes <= 5000) sonarTicTac();
  }, [Math.ceil(msRestantes / 1000)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sacudida de pantalla al agotarse el tiempo (una vez por pregunta).
  useEffect(() => {
    if (congelada || !idPregunta || msRestantes > 0) return undefined;
    if (sacudidoRef.current === idPregunta) return undefined;
    sacudidoRef.current = idPregunta;
    setSacudir(true);
    const t = setTimeout(() => setSacudir(false), 450);
    return () => clearTimeout(t);
  }, [msRestantes <= 0, congelada, idPregunta]); // eslint-disable-line react-hooks/exhaustive-deps

  // El anfitrión revela la opción correcta al cerrar la ventana.
  useEventoSala(escuchar, 'trivia_reveal', ({ indice }) => {
    setIndiceCorrecto((prev) => (prev === null ? indice : prev));
  });

  // El cartel de racha se apaga solo.
  useEffect(() => {
    if (!combo) return undefined;
    const t = setTimeout(() => setCombo(null), 1500);
    return () => clearTimeout(t);
  }, [combo]);

  async function responder(opcion) {
    if (respondida || enviando || congelada || msRestantes <= 0 || !idPregunta) return;
    setEnviando(true);
    try {
      const resultado = await api.triviaResponder(opcion, idPregunta);
      setRespondida({ ...resultado, elegida: opcion });
      if (resultado.correcta) {
        sonarAcierto();
        vibrarExito();
        if (resultado.multiplicador > 1) {
          setCombo(resultado.multiplicador);
          confetiRafaga();
        }
      } else {
        sonarFallo();
        vibrarFallo();
      }
      setVelo({ tipo: resultado.correcta ? 'acierto' : 'fallo', clave: ++veloClaveRef.current });

      enviar('trivia_resp', {
        jugador: sesion.idJugador,
        nickname: sesion.nickname,
        idPregunta,
        correcta: resultado.correcta,
        puntos: resultado.puntos,
      });
    } catch (err) {
      if (String(err.message).includes('Ya respondiste')) {
        setRespondida({ correcta: null, puntos: 0, elegida: opcion });
      }
    } finally {
      setEnviando(false);
    }
  }

  const tiempoTexto = formatearMs(msRestantes, true).replace('0:', '');
  const tiempoAgotado = msRestantes <= 0 && !congelada;

  return (
    <div className={`flex flex-col gap-4 flex-1 ${sacudir ? 'animate-sacudir' : ''}`}>
      <FlashEvento tipo={velo?.tipo} clave={velo?.clave} />
      {combo > 1 && (
        <div className="pointer-events-none fixed left-1/2 top-1/4 z-30 -translate-x-1/2 animate-pop">
          <span className="rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 px-6 py-2 text-3xl font-black text-[#1B1035] shadow-2xl shadow-orange-500/50">
            ¡RACHA x{combo}!
          </span>
        </div>
      )}
      {/* Barra de tiempo */}
      <div className="flex items-center gap-3">
        <span
          className={`text-2xl font-black tabular-nums w-16 font-display ${
            tiempoAgotado
              ? 'text-red-400'
              : msRestantes < 3000
                ? 'text-red-400 animate-pulso-reloj'
                : msRestantes < 7000
                  ? 'text-orange-300 animate-pulso-reloj'
                  : msRestantes < 12000
                    ? 'text-amber-300'
                    : 'text-sky-300'
          }`}
        >
          <span
            key={Math.ceil(msRestantes / 1000)}
            className={`inline-block ${msRestantes > 0 && msRestantes <= 5000 ? 'animate-tic' : ''}`}
          >
            {tiempoTexto}
          </span>
        </span>
        <div className="flex-1 h-3 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full rounded-full transition-none ${
              tiempoAgotado || msRestantes < 3000
                ? 'bg-red-400'
                : msRestantes < 7000
                  ? 'bg-orange-400'
                  : 'bg-gradient-to-r from-sky-400 to-cyan-400'
            }`}
            style={{ width: `${progreso * 100}%` }}
          />
        </div>
        <span className="text-[10px] font-bold uppercase text-[#8B80B3] w-10 text-right">
          Ronda {juego.ronda ?? 1}
        </span>
      </div>

      {/* Pregunta */}
      <div className="rounded-2xl border border-white/10 bg-white/[0.04] p-5 text-center">
        {pregunta ? (
          <p className="text-lg font-semibold leading-snug">{pregunta.pregunta}</p>
        ) : (
          <SkeletonLineas lineas={2} className="mx-auto max-w-sm py-1" />
        )}
      </div>

      {/* Opciones */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {(pregunta?.opciones || []).map((opcion, i) => {
          const revelada = indiceCorrecto !== null && i === indiceCorrecto;
          const esMiEleccion = respondida?.elegida === i;
          return (
            <button
              key={i}
              type="button"
              onClick={() => responder(i)}
              disabled={Boolean(respondida) || enviando || tiempoAgotado || congelada || !pregunta}
              style={revelada ? { animationDelay: `${i * 60}ms` } : undefined}
              className={`relative flex items-center gap-3 rounded-2xl border px-4 py-4 text-left font-semibold transition active:scale-[0.98] disabled:cursor-not-allowed ${
                revelada
                  ? 'border-green-400/60 bg-green-400/15 text-green-200 animate-girar-opcion'
                  : esMiEleccion && respondida?.correcta === false
                    ? 'border-red-400/60 bg-red-400/15 text-red-200'
                    : esMiEleccion
                      ? 'border-sky-400/60 bg-sky-400/15 text-sky-100'
                      : 'border-white/10 bg-white/[0.05] hover:border-white/25 disabled:opacity-50'
              }`}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 text-sm font-black">
                {LETRAS_OPCION[i]}
              </span>
              <span className="text-[15px]">{opcion}</span>
            </button>
          );
        })}
      </div>

      {/* Feedback */}
      {respondida && respondida.correcta !== null && (
        <div
          className={`rounded-2xl px-4 py-3 text-center font-extrabold animate-pop ${
            respondida.correcta
              ? 'bg-green-500/15 border border-green-400/40 text-green-300 animate-destello'
              : 'bg-red-500/15 border border-red-400/40 text-red-300'
          }`}
        >
          {respondida.correcta ? '¡CORRECTO! ' : 'Uhh, no era. '}
          {respondida.correcta ? (
            <span className="tabular-nums">
              +{respondida.puntos} pts
              {respondida.multiplicador > 1 && ` (x${respondida.multiplicador} racha)`}
            </span>
          ) : (
            <span>racha reiniciada</span>
          )}
        </div>
      )}
      {respondida && respondida.correcta === null && (
        <div className="rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-center text-sm text-[#B8AFD9]">
          Ya habías respondido esta pregunta.
        </div>
      )}
      {tiempoAgotado && !respondida && (
        <div className="rounded-2xl border border-orange-400/40 bg-orange-400/10 px-4 py-3 text-center text-sm font-bold text-orange-300">
          Se derritió el tiempo 🫠 Esperando la próxima pregunta...
        </div>
      )}
    </div>
  );
}
