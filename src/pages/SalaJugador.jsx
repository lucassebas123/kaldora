// src/pages/SalaJugador.jsx
//
// HUB DINÁMICO del jugador (/jugar/:codigo).
// Escucha el estado de la sala por Realtime y MUTA la interfaz según
// sala.estado + sala.juego_actual:
//   en_espera   -> sala de espera viva (lista de jugadores, preview del juego)
//   jugando     -> el minijuego elegido por el anfitrión (Rosco/Trivia/Basta/
//                  Supervivencia), cada uno con su propia pantalla
//   pausado     -> overlay de pausa sobre el juego actual
//   finalizado  -> podio con confeti
//
// La sesión del jugador se restaura desde localStorage; si no coincide con
// el código de la URL, se devuelve a la landing con el PIN precargado.

import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, WifiOff, Users, Sparkles } from 'lucide-react';
import FondoAnimado from '../components/FondoAnimado';
import BotonMusica from '../components/BotonMusica';
import HeaderJugador from '../components/HeaderJugador';
import Podio from '../components/Podio';
import TransicionVista from '../components/TransicionVista';
import { useSalaRealtime } from '../hooks/useSalaRealtime';
import { api, leerSesionJugador, borrarSesionJugador } from '../api/kaldoraApi';
import { JUEGOS, MATIZ_BASE } from '../game/constantes';
import RoscoJugador from './jugador/RoscoJugador';
import TriviaJugador from './jugador/TriviaJugador';
import BastaJugador from './jugador/BastaJugador';
import SupervivenciaJugador from './jugador/SupervivenciaJugador';

export default function SalaJugador() {
  const { codigo } = useParams();
  const navigate = useNavigate();
  const [sesion, setSesion] = useState(null);
  const [verificando, setVerificando] = useState(true);

  // Restauración de sesión por código de sala.
  useEffect(() => {
    const s = leerSesionJugador();
    if (s && s.codigo === codigo) {
      setSesion(s);
    } else {
      // Sin sesión para esta sala: volver al portal con el PIN precargado.
      navigate(`/?sala=${codigo}`, { replace: true });
      return;
    }
    setVerificando(false);
  }, [codigo, navigate]);

  const { sala, jugadores, online, listo, verificada, error, offsetReloj, escuchar, enviar, recargar } =
    useSalaRealtime(sesion?.idSala, { sesionJugador: sesion, esAnfitrion: false });

  const jugadorPropio = useMemo(
    () => jugadores.find((j) => j.id === sesion?.idJugador) || null,
    [jugadores, sesion]
  );

  // La sala fue borrada / la sesión ya no es válida. SOLO con la sala ya
  // verificada contra la base (evita la expulsión por la carrera del primer
  // render, donde sala aún es null mientras carga).
  useEffect(() => {
    if (verificada && sala === null && !error) {
      borrarSesionJugador();
      navigate('/', { replace: true });
    }
  }, [verificada, sala, error, navigate]);

  async function salir() {
    try {
      await api.salirSala(sesion.token);
    } catch {
      /* la sesión ya podía estar inválida */
    }
    borrarSesionJugador();
    navigate('/', { replace: true });
  }

  if (verificando || !listo || !verificada) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0B0616] text-[#B8AFD9]">
        <Loader2 className="animate-spin mr-3" />
        Entrando a la sala...
      </div>
    );
  }

  if (error || (verificada && !sala)) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-[#0B0616] text-[#B8AFD9] px-8 text-center">
        <WifiOff className="text-red-400" size={32} />
        <p>{error?.message || 'Perdimos la conexión con la sala.'}</p>
        <button
          onClick={() => navigate('/', { replace: true })}
          className="rounded-full bg-white/10 px-6 py-2 text-sm font-semibold hover:bg-white/20 transition"
        >
          Volver al inicio
        </button>
      </div>
    );
  }

  const enPausa = sala.estado === 'pausado';
  const propsComunes = {
    sala,
    jugadores,
    sesion,
    jugadorPropio,
    online,
    offsetReloj,
    escuchar,
    enviar,
    recargar,
  };

  // Vista actual (SIN la pausa: al pausar no se remonta el juego).
  const vista =
    sala.estado === 'en_espera'
      ? 'espera'
      : sala.estado === 'finalizado'
        ? 'podio'
        : sala.juego_actual || 'vacio';
  // El fondo tiñe la paleta del juego activo (rosco ámbar, trivia celeste...).
  const matiz =
    sala.estado === 'finalizado' ? 45 : JUEGOS[sala.juego_actual]?.matiz || MATIZ_BASE;

  let contenido = null;

  if (sala.estado === 'en_espera') {
    contenido = (
      <EsperaJugador
        jugadores={jugadores}
        online={online}
        sesion={sesion}
        juegoActual={sala.juego_actual}
      />
    );
  } else if (sala.estado === 'finalizado') {
    contenido = (
      <Podio
        jugadores={jugadores}
        idJugadorPropio={sesion.idJugador}
        online={online}
      />
    );
  } else if (sala.juego_actual === 'rosco') {
    contenido = <RoscoJugador {...propsComunes} />;
  } else if (sala.juego_actual === 'trivia') {
    contenido = <TriviaJugador {...propsComunes} />;
  } else if (sala.juego_actual === 'basta') {
    contenido = <BastaJugador {...propsComunes} />;
  } else if (sala.juego_actual === 'supervivencia') {
    contenido = <SupervivenciaJugador {...propsComunes} />;
  } else {
    contenido = (
      <div className="flex flex-1 items-center justify-center text-[#8B80B3] text-sm">
        <Sparkles className="mr-2" size={16} />
        El anfitrión está eligiendo el próximo juego...
      </div>
    );
  }

  return (
    <div className="relative min-h-dvh text-white flex flex-col">
      <FondoAnimado densidad={45} matiz={matiz} />
      <BotonMusica tema={temaMusica(sala)} />

      <main className="flex-1 flex flex-col items-center px-4 py-5 sm:px-6">
        <div className="w-full max-w-md flex flex-col gap-4 flex-1">
          <HeaderJugador
            sesion={sesion}
            jugador={jugadorPropio}
            puntos={jugadorPropio?.puntos}
            racha={jugadorPropio?.racha || 0}
            onSalir={salir}
          />
          <TransicionVista claveVista={vista} className="flex flex-col gap-4 flex-1">
            {contenido}
          </TransicionVista>
        </div>
      </main>

      {enPausa && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-[#0B0616]/80 backdrop-blur-md">
          <div className="rounded-3xl border border-amber-400/40 bg-amber-400/10 px-10 py-8 text-center animate-rosco-blink">
            <p className="text-4xl mb-2">⏸️</p>
            <p className="text-lg font-extrabold text-amber-300">Juego pausado</p>
            <p className="text-xs text-[#B8AFD9] mt-1">El anfitrión reanuda en un momento.</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tema musical según el estado de la sala (música en vivo por contexto)
// ---------------------------------------------------------------------------
function temaMusica(sala) {
  if (sala.estado === 'finalizado') return 'podio';
  if (sala.estado === 'en_espera') return 'sala';
  return sala.juego_actual || 'sala';
}

// ---------------------------------------------------------------------------
// Sala de espera viva
// ---------------------------------------------------------------------------
function EsperaJugador({ jugadores, online, sesion, juegoActual }) {
  const juego = juegoActual ? JUEGOS[juegoActual] : null;

  return (
    <div className="flex flex-col gap-5 flex-1">
      <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-6 text-center">
        <p className="text-4xl mb-3 animate-float">🎮</p>
        <h1 className="text-lg font-extrabold">¡Estás dentro, {sesion.nickname}!</h1>
        <p className="text-sm text-[#B8AFD9] mt-1">
          Esperá a que el anfitrión arranque. Dejá esta pantalla abierta.
        </p>

        {juego && (
          <div className="mt-4 rounded-2xl border border-fuchsia-400/30 bg-fuchsia-400/10 px-4 py-3 animate-pop">
            <p className="text-[10px] uppercase tracking-widest text-fuchsia-300 font-bold">
              Se viene
            </p>
            <p className="text-base font-extrabold text-white mt-0.5">
              {juego.emoji} {juego.nombre}
            </p>
          </div>
        )}
      </div>

      <section>
        <h2 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-2">
          <Users size={14} />
          Jugadores en la sala ({jugadores.length})
        </h2>
        <div className="grid grid-cols-2 gap-2">
          {jugadores.map((j) => (
            <div
              key={j.id}
              className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${
                j.id === sesion.idJugador
                  ? 'border-fuchsia-400/40 bg-fuchsia-400/10'
                  : 'border-white/10 bg-white/[0.04]'
              }`}
            >
              <span
                title={online.has(j.id) ? 'Conectado' : 'Desconectado'}
                className={`h-2 w-2 rounded-full shrink-0 ${
                  online.has(j.id) ? 'bg-green-400' : 'bg-red-500/60'
                }`}
              />
              <span className="text-sm font-semibold truncate">{j.nickname}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
