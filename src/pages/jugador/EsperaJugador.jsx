// src/pages/jugador/EsperaJugador.jsx
//
// Sala de espera del celular: hero con tu avatar, PIN para compartir, tarjeta
// del juego que se viene con sus reglas, lista viva de jugadores y tips
// rotativos para que la espera entretenga.

import React, { useEffect, useState } from 'react';
import { Check, Share2, Users, Sparkles } from 'lucide-react';
import AvatarChip from '../../components/AvatarChip';
import { JUEGOS } from '../../game/constantes';

const TIPS = {
  rosco: [
    'Pasapalabra: si dudás, pasá la letra. Vuelve al final de la vuelta, sin costo.',
    'Cada acierto suma +100; cada error resta −50. ¡Cuidado con adivinar de más!',
    'El reloj es TOTAL: no se detiene entre letras. Administrá tu tiempo.',
  ],
  trivia: [
    'Respondé rápido: la base de 1000 puntos se derrite con cada milisegundo.',
    'Con 3 aciertos seguidos tu puntaje vale x2; con 5, vale x3. ¡Racha!',
    'Si dudás, arriesgá: una respuesta errada no quita puntos, solo corta la racha.',
  ],
  basta: [
    'Completá las 5 categorías y cantá ¡BASTA!: a los demás les quedan 10 segundos letales.',
    'Palabra repetida vale +5; única vale +10. Si el anfitrión te la tacha, 0.',
    'Palabras inventadas: el diccionario avisa, pero el anfitrión tiene la última palabra.',
  ],
  supervivencia: [
    'Verdadero o Falso: un error y quedás eliminado, sin excepciones.',
    'Quedarse sin responder también elimina. ¡No te duermas!',
    'Cada acierto suma +25. Aguantá hasta el final y quedate con el premio.',
  ],
  general: [
    'Compartí el PIN: cuantos más jugadores, más caos (y más divertido).',
    'Guardá tu PIN de jugador: con él volvés a entrar sin registrarte.',
    'El anfitrión proyecta la partida: mirá la pantalla grande si estás cerca.',
  ],
};

function TipsRotativos({ juegoActual }) {
  const lista = [...(TIPS[juegoActual] || []), ...TIPS.general];
  const cantidad = lista.length;
  const [indice, setIndice] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndice((v) => (v + 1) % cantidad), 6000);
    return () => clearInterval(id);
  }, [cantidad]);

  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3">
      <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-[#8B80B3] font-bold mb-1">
        <Sparkles size={11} /> Mientras esperás
      </p>
      <p key={indice} className="text-xs leading-relaxed text-[#B8AFD9] animate-entrada-vista">
        {lista[indice % lista.length]}
      </p>
    </div>
  );
}

export default function EsperaJugador({ jugadores, online, sesion, jugadorPropio, juegoActual }) {
  const juego = juegoActual ? JUEGOS[juegoActual] : null;
  const [copiado, setCopiado] = useState(false);

  async function compartir() {
    const url = `${window.location.origin}/?sala=${sesion.codigo}`;
    const texto = `¡Entrá a mi sala de Kaldora! PIN ${sesion.codigo}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: 'Kaldora', text: texto, url });
        return;
      } catch {
        /* canceló el share: no hacemos fallback */
        return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${texto} → ${url}`);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1800);
    } catch {
      /* sin clipboard: no rompemos la espera */
    }
  }

  return (
    <div className="flex flex-col gap-4 flex-1">
      {/* Hero: tu avatar + bienvenida + espera viva */}
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center">
        <span className="pointer-events-none absolute left-1/2 top-24 h-44 w-44 -translate-x-1/2 rounded-full bg-fuchsia-500/20 blur-3xl" />
        <div className="relative mx-auto mb-3 h-20 w-20">
          <span
            className="absolute inset-0 rounded-full border-2 border-fuchsia-400/40 animate-ping motion-reduce:animate-none"
            style={{ animationDuration: '2.8s' }}
          />
          <AvatarChip icono={jugadorPropio?.icono} color={jugadorPropio?.color} tamano="xl" online />
        </div>
        <h1 className="text-lg font-extrabold">¡Estás dentro, {sesion.nickname}!</h1>
        <p className="text-sm text-[#B8AFD9] mt-1">
          Esperá a que el anfitrión arranque. Dejá esta pantalla abierta.
        </p>
        <div className="mt-3 inline-flex items-center gap-1.5 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-1.5 text-[11px] font-bold text-fuchsia-200">
          Esperando al anfitrión
          <span className="flex gap-0.5" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <span
                key={i}
                className="h-1.5 w-1.5 rounded-full bg-fuchsia-300 animate-bounce motion-reduce:animate-none"
                style={{ animationDelay: `${i * 160}ms`, animationDuration: '0.9s' }}
              />
            ))}
          </span>
        </div>
      </div>

      {/* PIN + compartir */}
      <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-[#8B80B3] font-bold">PIN de la sala</p>
          <p className="text-2xl font-black tabular-nums tracking-[0.25em] text-amber-300">{sesion.codigo}</p>
        </div>
        <button
          type="button"
          onClick={compartir}
          className="flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-400/10 px-4 py-2 text-xs font-black text-amber-200 hover:bg-amber-400/20 active:scale-95 transition"
        >
          {copiado ? <Check size={14} /> : <Share2 size={14} />}
          {copiado ? '¡Copiado!' : 'Compartir'}
        </button>
      </div>

      {/* Juego que se viene + reglas */}
      {juego && (
        <div className={`rounded-3xl border border-white/10 bg-gradient-to-br ${juego.color} p-[1px] animate-pop`}>
          <div className="rounded-3xl bg-[#140B2A]/85 px-5 py-4">
            <p className="text-[10px] uppercase tracking-widest text-fuchsia-300 font-bold">Se viene</p>
            <p className="text-lg font-extrabold text-white mt-0.5">
              {juego.emoji} {juego.nombre}
            </p>
            <p className="text-xs leading-relaxed text-[#B8AFD9] mt-1">{juego.descripcion}</p>
          </div>
        </div>
      )}

      {/* Jugadores en la sala */}
      <section>
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-2">
          <Users size={14} />
          Jugadores en la sala ({jugadores.length})
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {jugadores.map((j, i) => (
            <div
              key={j.id}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 animate-pop ${
                j.id === sesion.idJugador
                  ? 'border-fuchsia-400/40 bg-fuchsia-400/10'
                  : 'border-white/10 bg-white/[0.04]'
              }`}
              style={{ animationDelay: `${Math.min(i, 12) * 45}ms` }}
            >
              <AvatarChip
                icono={j.icono}
                color={j.color}
                tamano="sm"
                online={online ? online.has(j.id) : null}
              />
              <span className="text-sm font-semibold truncate">{j.nickname}</span>
            </div>
          ))}
        </div>
      </section>

      <TipsRotativos juegoActual={juegoActual} />
    </div>
  );
}
