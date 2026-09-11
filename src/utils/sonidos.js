// src/utils/sonidos.js
//
// Efectos de sonido 100% sintetizados con la Web Audio API del navegador:
// pesan 0 KB (no dependen de MP3/WAV externos) y se generan en tiempo real.
//
// Uso:
//   sonarAcierto();       -> tono ascendente limpio
//   sonarFallo();         -> buzzer grave descendente
//   sonarPasapalabra();   -> campanilla / chime suave
//   sonarTicTac();        -> click rítmico (últimos 15 segundos del turno)
//   sonarAlarma();        -> bocina de tiempo agotado
//   inicializarAudio();   -> desbloquear el contexto (gesto inicial del usuario)

let contextoAudio = null;

/**
 * Devuelve (y reutiliza) el AudioContext del navegador.
 * Si estaba suspendido por políticas de autoplay, intenta reanudarlo.
 */
function obtenerContexto() {
  if (typeof window === 'undefined') return null;
  if (!contextoAudio) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      contextoAudio = new AudioCtx();
    } catch {
      return null;
    }
  }
  if (contextoAudio.state === 'suspended') {
    contextoAudio.resume().catch(() => {});
  }
  return contextoAudio;
}

/**
 * Toca una nota/tono con fade in/out suave para evitar "clicks" de corte.
 * Si 'retardo' > 0 se programa más tarde (permite arpegios escalonados).
 */
function tocarNota(frecuenciaInicial, frecuenciaFinal, duracion, opciones = {}) {
  const ctx = obtenerContexto();
  if (!ctx) return; // navegador sin Web Audio o contexto no disponible

  const { tipo = 'sine', volumen = 0.3, retardo = 0 } = opciones;
  const inicio = ctx.currentTime + retardo;

  const oscilador = ctx.createOscillator();
  const ganancia = ctx.createGain();

  oscilador.type = tipo;
  oscilador.frequency.setValueAtTime(Math.max(1, frecuenciaInicial), inicio);
  oscilador.frequency.exponentialRampToValueAtTime(
    Math.max(1, frecuenciaFinal),
    inicio + duracion
  );

  ganancia.gain.setValueAtTime(0.0001, inicio);
  ganancia.gain.exponentialRampToValueAtTime(volumen, inicio + 0.01);
  ganancia.gain.exponentialRampToValueAtTime(0.0001, inicio + duracion);

  oscilador.connect(ganancia).connect(ctx.destination);
  oscilador.start(inicio);
  oscilador.stop(inicio + duracion + 0.05);
}

/** Acierto: arpegio ascendente (Do5 - Mi5 - Sol5), limpio y celebratorio. */
export function sonarAcierto() {
  tocarNota(523.25, 523.25, 0.12, { tipo: 'triangle', volumen: 0.3 });
  tocarNota(659.25, 659.25, 0.12, { tipo: 'triangle', volumen: 0.3, retardo: 0.1 });
  tocarNota(783.99, 783.99, 0.3, { tipo: 'triangle', volumen: 0.32, retardo: 0.2 });
}

/** Fallo: buzzer grave descendente, doble capa para mayor presencia. */
export function sonarFallo() {
  tocarNota(220, 110, 0.4, { tipo: 'sawtooth', volumen: 0.22 });
  tocarNota(110, 55, 0.5, { tipo: 'square', volumen: 0.16, retardo: 0.12 });
}

/** Pasapalabra: campanilla suave (nota fundamental + armónico superior). */
export function sonarPasapalabra() {
  tocarNota(880, 880, 0.45, { tipo: 'sine', volumen: 0.2 });
  tocarNota(1318.51, 1318.51, 0.6, { tipo: 'sine', volumen: 0.1, retardo: 0.02 });
}

/** Tic-Tac: click corto y seco, rítmico durante los últimos 15 segundos. */
export function sonarTicTac() {
  tocarNota(1000, 850, 0.045, { tipo: 'square', volumen: 0.07 });
}

/** Alarma de tiempo agotado: secuencia de 3 pitidos ascendentes. */
export function sonarAlarma() {
  tocarNota(660, 660, 0.22, { tipo: 'square', volumen: 0.22 });
  tocarNota(880, 880, 0.22, { tipo: 'square', volumen: 0.22, retardo: 0.28 });
  tocarNota(1100, 1100, 0.5, { tipo: 'square', volumen: 0.22, retardo: 0.56 });
}

/** Victoria (podio): fanfarria Do-Mi-Sol-Do con destello final. */
export function sonarVictoria() {
  tocarNota(523.25, 523.25, 0.14, { tipo: 'triangle', volumen: 0.3 });
  tocarNota(659.25, 659.25, 0.14, { tipo: 'triangle', volumen: 0.3, retardo: 0.12 });
  tocarNota(783.99, 783.99, 0.14, { tipo: 'triangle', volumen: 0.3, retardo: 0.24 });
  tocarNota(1046.5, 1046.5, 0.5, { tipo: 'triangle', volumen: 0.34, retardo: 0.36 });
  tocarNota(1318.51, 1567.98, 0.55, { tipo: 'sine', volumen: 0.12, retardo: 0.44 });
}

/** Desbloquea el contexto de audio (debe llamarse dentro de un gesto del usuario). */
export function inicializarAudio() {
  obtenerContexto();
}