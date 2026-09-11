// src/pages/jugador/RoscoJugador.jsx
//
// EL ROSCO (modo individual, estilo Pasapalabra clásico):
//   * Reloj TOTAL continuo: corre desde el arranque del anfitrión y solo se
//     detiene al llegar a cero o cuando resolvés todo el rosco.
//   * PASAPALABRA: la letra queda "pendiente" (sin puntos, sin error) y
//     seguís con la siguiente; al final de la pasada, el ciclo vuelve en
//     círculo SOLO por las pendientes, en el orden original del abecedario.
//   * +100 por acierto, -50 por error (validación en el servidor).
//
// El estado individual vive en `jugadores.rosco` (letra actual + estados),
// sincronizado por broadcast/polling; la pregunta de cada letra la fija el
// servidor en rosco.q (mismo enunciado si recargás).

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Send, SkipForward, PartyPopper } from 'lucide-react';
import AnilloProgreso from '../../components/AnilloProgreso';
import Rosco, { LETRAS } from '../../components/Rosco';
import { useCuentaAtras, formatearMs } from '../../hooks/useCuentaAtras';
import { api, consultas } from '../../api/kaldoraApi';
import { ROSCO } from '../../game/constantes';
import { sonarAcierto, sonarFallo, sonarPasapalabra } from '../../utils/sonidos';
import { vibrarExito, vibrarFallo, vibrarPasapalabra, vibrarCelebracion } from '../../utils/haptico';
import { confetiExplosion } from '../../utils/confeti';
import FlashEvento from '../../components/FlashEvento';

export default function RoscoJugador({ sala, sesion, jugadorPropio, offsetReloj, enviar }) {
  const juego = sala.juego || {};
  const inicio = juego.inicio;
  const duracionMs = juego.duracion_ms || ROSCO.SEGUNDOS_DEFECTO * 1000;
  const congelada = sala.estado === 'pausado';

  // El estado del servidor llega por broadcast/polling (hasta ~3 s de demora).
  // Tras cada acción, `roscoEstado()` refresca el mío al instante (miRosco).
  const [miRosco, setMiRosco] = useState(null);
  const rosco = miRosco || jugadorPropio?.rosco || {};
  const letra = rosco.l || null;
  const preguntaId = rosco.q || null;
  const terminado = Boolean(rosco.t);

  const [pregunta, setPregunta] = useState(null);
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [flash, setFlash] = useState(null);
  const [velo, setVelo] = useState(null);
  const [restaurando, setRestaurando] = useState(Boolean(sesion?.token));
  const cerradoRef = useRef(null);

  // Nueva partida: limpiar el estado local (en render, al cambiar `inicio`).
  const [inicioPrevio, setInicioPrevio] = useState(inicio);
  if (inicioPrevio !== inicio) {
    setInicioPrevio(inicio);
    setMiRosco(null);
    setFlash(null);
  }

  // Cuenta atrás TOTAL (continua; se congela si el anfitrión pausa).
  const { msRestantes, progreso } = useCuentaAtras({
    fin: inicio ? new Date(new Date(inicio).getTime() + duracionMs).toISOString() : null,
    duracionMs,
    offsetReloj,
    congelada,
  });

  // Pregunta de la letra activa (la fija el servidor). El reseteo de la
  // pregunta/texto ocurre en render al cambiar `preguntaId`.
  const [preguntaIdPrevio, setPreguntaIdPrevio] = useState(preguntaId);
  if (preguntaIdPrevio !== preguntaId) {
    setPreguntaIdPrevio(preguntaId);
    setPregunta(null);
    setTexto('');
  }
  useEffect(() => {
    if (!preguntaId) return undefined;
    let vigente = true;
    consultas
      .preguntaRoscoPorId(preguntaId)
      .then((p) => vigente && setPregunta(p))
      .catch(() => vigente && setPregunta(null));
    return () => {
      vigente = false;
    };
  }, [preguntaId]);

  // Restaurar mi rosco tras recargar la página (letra, pregunta y estados).
  const [tokenPrevio, setTokenPrevio] = useState(sesion?.token);
  if (tokenPrevio !== sesion?.token) {
    setTokenPrevio(sesion?.token);
    setRestaurando(Boolean(sesion?.token));
  }
  useEffect(() => {
    if (!sesion?.token) return undefined;
    let vigente = true;
    api
      .roscoEstado()
      .then((estado) => {
        if (vigente && estado?.rosco && Object.keys(estado.rosco).length > 0) setMiRosco(estado.rosco);
      })
      .catch(() => {})
      .finally(() => vigente && setRestaurando(false));
    return () => {
      vigente = false;
    };
  }, [sesion?.token]);

  // Al vencer el tiempo total, cerrar el rosco propio (idempotente).
  useEffect(() => {
    if (congelada || !inicio) return;
    if (terminado) return;
    if (msRestantes > 0) {
      cerradoRef.current = null;
      return;
    }
    if (cerradoRef.current === inicio) return;
    cerradoRef.current = inicio;
    api.roscoCerrar().catch(() => {});
  }, [msRestantes, congelada, terminado, inicio]);

  async function enviarRespuesta(e) {
    e?.preventDefault?.();
    if (!letra || enviando || terminado || msRestantes <= 0 || congelada) return;
    const valor = texto.trim();
    if (!valor) return;

    setEnviando(true);
    try {
      const resultado = await api.roscoEnviar(valor);
      // Refresco instantáneo de mi estado (letra nueva + pregunta fija).
      api.roscoEstado().then((est) => est?.rosco && setMiRosco(est.rosco)).catch(() => {});
      if (resultado.correcta) {
        sonarAcierto();
        vibrarExito();
        setVelo({ tipo: 'acierto', clave: Date.now() });
      } else {
        sonarFallo();
        vibrarFallo();
        setVelo({ tipo: 'fallo', clave: Date.now() });
      }
      setFlash({
        tipo: resultado.correcta ? 'acierto' : 'error',
        puntos: resultado.puntos,
        letra: letra,
      });

      // Aviso volado al anfitrión (broadcast, sin escrituras).
      enviar('rosco_resp', {
        jugador: sesion.idJugador,
        nickname: sesion.nickname,
        letra: letra,
        correcta: resultado.correcta,
      });

      // ¡Rosco completo! Momento épico: confetti + celebración háptica.
      if (resultado.terminado) {
        sonarAcierto();
        confetiExplosion();
        vibrarCelebracion();
      }
    } catch {
      /* letra expirada / doble envío: el estado oficial llega por broadcast */
    } finally {
      setEnviando(false);
    }
  }

  async function pasar() {
    if (!letra || enviando || terminado || msRestantes <= 0 || congelada) return;
    try {
      await api.roscoPasar();
      api.roscoEstado().then((est) => est?.rosco && setMiRosco(est.rosco)).catch(() => {});
      sonarPasapalabra();
      vibrarPasapalabra();
      setFlash({ tipo: 'pasa', letra: letra });
    } catch {
      /* letra expirada u otro benigno */
    }
  }

  // ---------------------------------------------------------------------------
  // Estados del rosco personal (1 acierto, 2 error, 3 pasapalabra, 4 sin pregunta)
  // ---------------------------------------------------------------------------
  const estados = rosco.e || {};
  const estadosRosco = Object.fromEntries(
    LETRAS.map((l) => {
      const v = estados[l];
      const nombre = v === 1 ? 'acierto' : v === 2 ? 'error' : v === 3 ? 'pasapalabra' : 'pendiente';
      return [l, nombre];
    })
  );

  const aciertos = Object.values(estados).filter((v) => v === 1).length;
  const errores = Object.values(estados).filter((v) => v === 2).length;
  const pasapalabras = Object.values(estados).filter((v) => v === 3).length;

  const tiempoTexto = formatearMs(msRestantes, true).replace(/^0:/, '');
  const tiempoAgotado = msRestantes <= 0 && !congelada;

  // ---------------------------------------------------------------------------
  // Terminado: resumen personal
  // ---------------------------------------------------------------------------
  if (terminado) {
    return (
      <div className="flex flex-col gap-4 flex-1">
        <div className="rounded-3xl border border-amber-400/40 bg-amber-400/10 p-6 text-center">
          <PartyPopper className="mx-auto text-amber-300 mb-2" size={34} />
          <p className="text-lg font-black text-amber-200">
            {tiempoAgotado ? '¡Se acabó el tiempo!' : '¡Rosco completo!'}
          </p>
          <p className="text-sm text-[#B8AFD9] mt-1">
            {aciertos} aciertos · {errores} errores · {pasapalabras} pasapalabra
          </p>
          <p className="text-xs text-[#6C6193] mt-2">
            Esperá a que el anfitrión termine la partida.
          </p>
        </div>
        <div className="flex justify-center">
          <div className="w-64 h-64">
            <Rosco estados={estadosRosco} letraActual={null} tamano={260} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 flex-1">
      <FlashEvento tipo={velo?.tipo} clave={velo?.clave} />
      {/* Reloj total del rosco */}
      <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
        <div className={msRestantes <= 10000 && msRestantes > 0 ? 'animate-pulso-reloj' : ''}>
          <AnilloProgreso
            progreso={progreso}
            tamano={92}
            grosor={7}
            texto={tiempoTexto}
            subtexto="total"
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs uppercase tracking-wider text-[#8B80B3] font-bold">
            Letra {letra || '...'}
          </p>
          <p className="text-[15px] font-semibold leading-snug mt-1">
            {restaurando ? (
              <span className="text-[#8B80B3]">Recuperando tu rosco...</span>
            ) : pregunta?.pregunta ? (
              pregunta.pregunta
            ) : (
              <span className="flex flex-col gap-2">
                <span className="skeleton h-3.5 rounded-md" style={{ width: '92%' }} />
                <span className="skeleton h-3.5 rounded-md" style={{ width: '58%' }} />
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Flash de resultado */}
      {flash && (
        <div
          className={`rounded-2xl px-4 py-3 text-center font-extrabold animate-pop ${
            flash.tipo === 'acierto'
              ? 'bg-green-500/15 border border-green-400/40 text-green-300 animate-destello'
              : flash.tipo === 'pasa'
                ? 'bg-yellow-500/15 border border-yellow-400/40 text-yellow-300'
                : 'bg-red-500/15 border border-red-400/40 text-red-300'
          }`}
        >
          {flash.tipo === 'acierto' && `¡CORRECTO! +${flash.puntos} pts`}
          {flash.tipo === 'pasa' && `Pasapalabra: "${flash.letra}" queda pendiente`}
          {flash.tipo === 'error' && `Errado ${flash.puntos !== 0 ? `${flash.puntos} pts` : ''}`}
        </div>
      )}

      {/* Respuesta + pasapalabra */}
      <form onSubmit={enviarRespuesta} className="flex gap-2">
        <input
          value={texto}
          onChange={(e) => setTexto(e.target.value.slice(0, 60))}
          disabled={terminado || tiempoAgotado || congelada || !letra}
          placeholder={`Palabra con ${letra || '...'}`}
          autoFocus
          autoComplete="off"
          className="flex-1 h-14 rounded-2xl bg-white/[0.06] border border-white/15 px-4 text-lg font-semibold outline-none focus:border-amber-400/80 transition disabled:opacity-40 placeholder:font-normal placeholder:text-sm"
        />
        <button
          type="submit"
          disabled={enviando || !texto.trim() || terminado || tiempoAgotado || congelada}
          className="h-14 px-4 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1B1035] font-extrabold hover:brightness-110 active:scale-95 transition disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {enviando ? <Loader2 className="animate-spin" size={20} /> : <Send size={20} />}
        </button>
        <button
          type="button"
          onClick={pasar}
          disabled={terminado || tiempoAgotado || congelada || !letra}
          className="h-14 px-4 rounded-2xl bg-white/[0.08] border border-white/15 text-white font-bold text-sm flex flex-col items-center justify-center hover:bg-white/15 transition disabled:opacity-40 disabled:cursor-not-allowed"
          title="Pasar la palabra: queda pendiente para la próxima vuelta"
        >
          <SkipForward size={17} />
          <span className="text-[9px] uppercase tracking-wide">Pasar</span>
        </button>
      </form>

      {/* Mi rosco personal */}
      <div className="flex flex-col items-center gap-2">
        <p className="text-[10px] uppercase tracking-widest text-[#8B80B3] font-bold">
          Tu rosco · {aciertos} ✓ · {errores} ✗ · {pasapalabras} ⏭
        </p>
        <div className="w-64 h-64 sm:w-72 sm:h-72">
          <Rosco estados={estadosRosco} letraActual={letra} tamano={280} />
        </div>
      </div>
    </div>
  );
}
