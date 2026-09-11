// src/utils/musica.js
//
// MÚSICA AMBIENTE 100% sintetizada con Web Audio (0 KB de assets):
//   * Un loop por contexto: portal, sala, rosco, trivia, basta,
//     supervivencia y podio.
//   * Cámbiala en vivo con setTema(); apágala con setMute() (persistente
//     en localStorage 'kaldora_musica').
//   * Arranca con el primer gesto del usuario (política de autoplay).
//
// El sonido es deliberadamente suave: pads con ataque lento + arpegios
// cortos, volumen bajo, para acompañar y no molestar.

let ctx = null;
let master = null; // ganancia general (mute)
let temaActual = null;
let temporizador = null; // scheduler
let paso = 0; // paso del patrón (por corchea)
let proximoTiempo = 0; // reloj de programación (audio time)
const BPM_DEFECTO = 84;

const TEMAS = {
  portal: {
    acordes: [
      [220.0, 261.63, 329.63], // Am
      [174.61, 220.0, 261.63], // F
      [130.81, 164.81, 196.0], // C
      [196.0, 246.94, 293.66], // G
    ],
    arpegio: [440, 523.25, 659.25, 523.25],
    bpm: 76,
    padTipo: 'sine',
    onda: 'triangle',
    volumenPad: 0.05,
    volumenArp: 0.035,
  },
  sala: {
    acordes: [
      [261.63, 329.63, 392.0], // C
      [220.0, 261.63, 329.63], // Am
      [174.61, 220.0, 261.63], // F
      [196.0, 246.94, 293.66], // G
    ],
    arpegio: [523.25, 659.25, 783.99, 659.25],
    bpm: 88,
    padTipo: 'sine',
    onda: 'sine',
    volumenPad: 0.05,
    volumenArp: 0.03,
  },
  rosco: {
    acordes: [
      [146.83, 220.0, 261.63], // Am con bajo
      [130.81, 196.0, 246.94], // G
      [123.47, 185.0, 233.08], // Bdim-ish tensión
      [130.81, 196.0, 261.63], // C
    ],
    arpegio: [440, 523.25, 587.33, 523.25],
    bpm: 96,
    padTipo: 'triangle',
    onda: 'triangle',
    volumenPad: 0.045,
    volumenArp: 0.028,
  },
  trivia: {
    acordes: [
      [261.63, 329.63, 392.0], // C
      [293.66, 349.23, 440.0], // D
      [220.0, 277.18, 329.63], // Am
      [246.94, 293.66, 369.99], // Bm
    ],
    arpegio: [523.25, 659.25, 880, 659.25, 523.25, 783.99],
    bpm: 118,
    padTipo: 'sawtooth',
    onda: 'square',
    volumenPad: 0.03,
    volumenArp: 0.024,
  },
  basta: {
    acordes: [
      [207.65, 261.63, 311.13], // Abmaj-ish urgente
      [233.08, 293.66, 349.23], // Bb
      [220.0, 277.18, 329.63], // Am
      [246.94, 311.13, 369.99], // Bm
    ],
    arpegio: [622.25, 523.25, 622.25, 783.99],
    bpm: 126,
    padTipo: 'sawtooth',
    onda: 'sawtooth',
    volumenPad: 0.028,
    volumenArp: 0.022,
  },
  supervivencia: {
    acordes: [
      [110.0, 164.81, 207.65], // Am grave
      [110.0, 130.81, 164.81], // drone tenso
      [98.0, 146.83, 185.0], // G grave
      [110.0, 138.59, 164.81], // disonancia sutil
    ],
    arpegio: [220, 261.63, 220, 196],
    bpm: 100,
    padTipo: 'sawtooth',
    onda: 'triangle',
    volumenPad: 0.04,
    volumenArp: 0.02,
  },
  podio: {
    acordes: [
      [261.63, 329.63, 392.0, 523.25], // C mayor abierto
      [220.0, 261.63, 329.63, 440.0], // Am
      [174.61, 220.0, 261.63, 349.23], // F
      [196.0, 246.94, 293.66, 392.0], // G
    ],
    arpegio: [523.25, 659.25, 783.99, 1046.5],
    bpm: 104,
    padTipo: 'triangle',
    onda: 'triangle',
    volumenPad: 0.055,
    volumenArp: 0.04,
  },
};

function obtenerContexto() {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      ctx = new AudioCtx();
    } catch {
      return null;
    }
    master = ctx.createGain();
    master.gain.value = estaMuteado() ? 0 : 1;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

// --- notas -------------------------------------------------------------------
function tocarPad(frecuencias, duracion, tema, cuando) {
  frecuencias.forEach((f, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filtro = ctx.createBiquadFilter();
    filtro.type = 'lowpass';
    filtro.frequency.value = 1200;

    osc.type = tema.padTipo;
    osc.frequency.value = f;
    const volumen = tema.volumenPad * (1 - i * 0.18);

    gain.gain.setValueAtTime(0.0001, cuando);
    gain.gain.linearRampToValueAtTime(volumen, cuando + duracion * 0.25); // ataque suave
    gain.gain.linearRampToValueAtTime(volumen * 0.8, cuando + duracion * 0.7);
    gain.gain.linearRampToValueAtTime(0.0001, cuando + duracion);

    osc.connect(filtro).connect(gain).connect(master);
    osc.start(cuando);
    osc.stop(cuando + duracion + 0.1);
  });
}

function tocarArpegio(nota, tema, cuando) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = tema.onda;
  osc.frequency.value = nota;
  gain.gain.setValueAtTime(0.0001, cuando);
  gain.gain.linearRampToValueAtTime(tema.volumenArp, cuando + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, cuando + 0.28);
  osc.connect(gain).connect(master);
  osc.start(cuando);
  osc.stop(cuando + 0.35);
}

// --- scheduler ----------------------------------------------------------------
const PASOS_POR_CORCHEA = 1;
function programar() {
  const tema = TEMAS[temaActual];
  if (!tema) return;

  const corchea = 60 / tema.bpm / 2; // corcheas
  const horizon = ctx.currentTime + 0.6; // mira 600 ms adelante

  while (proximoTiempo < horizon) {
    const compas = Math.floor(paso / 8) % tema.acordes.length;

    // Pad al inicio de cada compás (8 corcheas).
    if (paso % 8 === 0) {
      tocarPad(tema.acordes[compas], corchea * 8 * 0.98, tema, proximoTiempo);
    }
    // Arpegio en corcheas alternas.
    if (paso % PASOS_POR_CORCHEA === 0) {
      const nota = tema.arpegio[paso % tema.arpegio.length];
      tocarArpegio(nota, tema, proximoTiempo);
    }

    paso++;
    proximoTiempo += corchea;
  }
}

// --- API pública ---------------------------------------------------------------
export function estaMuteado() {
  try {
    return localStorage.getItem('kaldora_musica') === '0';
  } catch {
    return false;
  }
}

export function setMute(muteado) {
  try {
    localStorage.setItem('kaldora_musica', muteado ? '0' : '1');
  } catch {
    /* almacenamiento no disponible */
  }
  if (master && ctx) {
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(muteado ? 0 : 1, ctx.currentTime + 0.2);
  }
  if (!muteado && !temporizador && temaActual) iniciar();
}

export function alternarMute() {
  setMute(!estaMuteado());
  return estaMuteado();
}

/** Cambia el tema musical en vivo ('portal' | 'sala' | 'rosco' | ...). */
export function setTema(tema) {
  if (!TEMAS[tema] || tema === temaActual) return;
  temaActual = tema;
  paso = 0;
  if (ctx && !estaMuteado()) iniciar();
}

/** Arranca el loop (requiere gesto previo del usuario). */
export function iniciar() {
  if (estaMuteado() || !temaActual) return;
  const c = obtenerContexto();
  if (!c || temporizador) return;
  proximoTiempo = c.currentTime + 0.1;
  temporizador = setInterval(programar, 200);
}

export function detener() {
  if (temporizador) {
    clearInterval(temporizador);
    temporizador = null;
  }
}

/** Desbloqueo de autoplay: primer gesto del usuario en cualquier página. */
export function armarAutoplay() {
  if (typeof window === 'undefined') return;
  const arrancar = () => {
    obtenerContexto();
    if (!estaMuteado() && temaActual) iniciar();
    window.removeEventListener('pointerdown', arrancar);
    window.removeEventListener('keydown', arrancar);
  };
  window.addEventListener('pointerdown', arrancar, { once: true });
  window.addEventListener('keydown', arrancar, { once: true });
}
