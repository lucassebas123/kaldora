// src/pages/admin/AdminSala.jsx
//
// CENTRO DE CONTROL del anfitrión (/admin/sala/:id) — pensado para proyectar.
//   lobby        -> QR gigante + PIN, jugadores en vivo, selector de juego
//   jugando      -> panel de control del juego activo (proyección + moderación)
//   pausado      -> mismo panel con banner de pausa
//   finalizado   -> podio + revancha
//
// La ruta está protegida por Supabase Auth (ver App.jsx / RutaProtegida).

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import {
  Loader2, Users, Play, Pause, LogOut, WifiOff, Square, Undo2, Copy, Check, BookOpen, Keyboard,
} from 'lucide-react';
import FondoAnimado from '../../components/FondoAnimado';
import BotonMusica from '../../components/BotonMusica';
import AvatarChip from '../../components/AvatarChip';
import BannerConexion from '../../components/BannerConexion';
import Podio from '../../components/Podio';
import TransicionVista from '../../components/TransicionVista';
import BancoPreguntas from './BancoPreguntas';
import { useSalaRealtime } from '../../hooks/useSalaRealtime';
import { api } from '../../api/kaldoraApi';
import { JUEGOS, MATIZ_BASE } from '../../game/constantes';
import PanelRosco from './paneles/PanelRosco';
import PanelTrivia from './paneles/PanelTrivia';
import PanelBasta from './paneles/PanelBasta';
import PanelSupervivencia from './paneles/PanelSupervivencia';

const URL_BASE = import.meta.env.VITE_APP_URL || window.location.origin;

export default function AdminSala() {
  const { id } = useParams();
  const navigate = useNavigate();

  const { sala, jugadores, online, listo, error, degradado, offsetReloj, escuchar, enviar, publicarEstado, recargar } =
    useSalaRealtime(id, { esAnfitrion: true });

  const [trabajando, setTrabajando] = useState(false);
  const [mostrarBanco, setMostrarBanco] = useState(false);
  const [aviso, setAviso] = useState(null);

  const ejecutar = useCallback(async (fn) => {
    if (trabajando) return;
    setTrabajando(true);
    setAviso(null);
    try {
      await fn();
      // Re-publica la instantánea por broadcast: los celulares reaccionan al
      // instante sin depender de la entrega de postgres_changes.
      await publicarEstado();
    } catch (err) {
      // Antes solo quedaba en consola: el host creía que la acción funcionó.
      console.warn('[anfitrión]', err.message);
      setAviso(err.message || 'La acción no se pudo completar. Probá otra vez.');
    } finally {
      setTrabajando(false);
    }
  }, [publicarEstado, trabajando]);

  // ---------------------------------------------------------------------------
  // ATAJOS DE TECLADO para el anfitrión:
  //   Espacio = avanzar (siguiente pregunta / cerrar countdown / nueva ronda)
  //   P       = pausar / reanudar
  // Ignora teclas mientras se escribe o el banco de preguntas está abierto.
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const alTecla = (e) => {
      if (e.repeat || mostrarBanco) return;
      const foco = document.activeElement;
      if (foco && (foco.tagName === 'INPUT' || foco.tagName === 'TEXTAREA' || foco.isContentEditable)) return;

      const jugando = sala?.estado === 'jugando';
      const juego = sala?.juego_actual;
      const fase = sala?.juego?.fase;

      if (e.code === 'Space') {
        e.preventDefault();
        if (!jugando) return;
        if (juego === 'trivia') ejecutar(() => api.triviaSiguiente(sala.id));
        else if (juego === 'supervivencia') ejecutar(() => api.supervivenciaSiguiente(sala.id));
        else if (juego === 'basta') {
          if (fase === 'cuenta_atras') ejecutar(() => api.bastaCerrarRonda(sala.id));
          else if (fase === 'resultados') ejecutar(() => api.bastaIniciarRonda(sala.id));
        }
        // rosco: los relojes son individuales, el host no avanza nada.
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        if (sala?.estado === 'jugando') ejecutar(() => api.pausarPartida(sala.id));
        else if (sala?.estado === 'pausado') ejecutar(() => api.reanudarPartida(sala.id));
      }
    };
    window.addEventListener('keydown', alTecla);
    return () => window.removeEventListener('keydown', alTecla);
  }, [sala, mostrarBanco, ejecutar]);

  if (!listo) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-[#0B0616] text-[#B8AFD9]">
        <Loader2 className="animate-spin mr-3" />
        Abriendo la sala...
      </div>
    );
  }

  if (error || !sala) {
    return (
      <div className="min-h-dvh flex flex-col items-center justify-center gap-4 bg-[#0B0616] text-[#B8AFD9] px-8 text-center">
        <WifiOff className="text-red-400" size={32} />
        <p>{error?.message || 'Esta sala ya no existe (fue borrada).'}</p>
        <button
          onClick={() => navigate('/admin', { replace: true })}
          className="rounded-full bg-white/10 px-6 py-2 text-sm font-semibold hover:bg-white/20 transition"
        >
          Volver al panel
        </button>
      </div>
    );
  }

  const props = { sala, jugadores, online, offsetReloj, escuchar, enviar, recargar, ejecutar, trabajando };

  // Vista sin la pausa: al pausar no se remonta el panel.
  const vista =
    sala.estado === 'en_espera'
      ? 'lobby'
      : sala.estado === 'finalizado'
        ? 'podio'
        : sala.juego_actual || 'vacio';
  const matiz =
    sala.estado === 'finalizado' ? 45 : JUEGOS[sala.juego_actual]?.matiz || MATIZ_BASE;

  return (
    <div className="relative min-h-dvh text-white">
      <FondoAnimado densidad={30} matiz={matiz} />
      <BotonMusica tema={sala.estado === 'finalizado' ? 'podio' : sala.juego_actual || 'sala'} />

      <main className="mx-auto max-w-6xl px-6 pt-safe pb-safe flex flex-col min-h-dvh">
        {/* Barra superior de estado */}
        <header className="flex flex-wrap items-center gap-3 mb-6">
          <span className="text-3xl font-black tabular-nums tracking-[0.2em] text-amber-300 font-display">
            {sala.codigo}
          </span>
          <span
            className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-wider ${
              sala.estado === 'en_espera'
                ? 'bg-green-500/15 text-green-300 border-green-400/30'
                : sala.estado === 'jugando'
                  ? 'bg-sky-500/15 text-sky-300 border-sky-400/30'
                  : sala.estado === 'pausado'
                    ? 'bg-amber-500/15 text-amber-300 border-amber-400/30'
                    : 'bg-white/10 text-[#B8AFD9] border-white/15'
            }`}
          >
            {sala.estado}
          </span>
          <span className="flex items-center gap-1.5 text-sm text-[#8B80B3]">
            <Users size={15} /> {jugadores.length} jugadores
          </span>

          {sala.estado === 'jugando' && (
            <span
              title="Atajos de teclado"
              className="hidden lg:flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold text-[#8B80B3]"
            >
              <Keyboard size={12} />
              <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-white/80">Espacio</kbd> avanzar
              <kbd className="rounded bg-white/10 px-1.5 py-0.5 text-white/80">P</kbd> pausa
            </span>
          )}

          <span className="flex-1" />

          {/* Controles maestros: envuelven en pantallas angostas para no
              ensanchar la página (el ancho mínimo de la fila era 368 px). */}
          <div className="flex flex-wrap items-center gap-2">
            <BotonControl
              onClick={() => setMostrarBanco(true)}
              icono={<BookOpen size={14} />}
              texto="Banco de preguntas"
              tono="bg-sky-500/20 hover:bg-sky-500/30 text-sky-200"
              titulo="Editar y cargar preguntas de los 4 juegos"
            />
            {(sala.estado === 'jugando' || sala.estado === 'pausado') && (
              <BotonControl
                onClick={() =>
                  ejecutar(() =>
                    sala.estado === 'pausado'
                      ? api.reanudarPartida(sala.id)
                      : api.pausarPartida(sala.id)
                  )
                }
                disabled={trabajando}
                icono={sala.estado === 'pausado' ? <Play size={14} /> : <Pause size={14} />}
                texto={sala.estado === 'pausado' ? 'Reanudar' : 'Pausar'}
                tono="bg-white/10 hover:bg-white/20"
              />
            )}
            <BotonControl
              onClick={() => {
                if (
                  sala.estado !== 'en_espera' &&
                  !window.confirm('¿Volver al lobby? Se reinician los puntos y las respuestas de la partida.')
                ) {
                  return;
                }
                ejecutar(() => api.volverAlLobby(sala.id));
              }}
              disabled={trabajando || sala.estado === 'en_espera'}
              icono={<Undo2 size={14} />}
              texto="Lobby"
              tono="bg-white/10 hover:bg-white/20"
              titulo="Reinicia puntos y vuelve al lobby (revancha)"
            />
            <BotonControl
              onClick={() => ejecutar(() => api.terminarPartida(sala.id))}
              disabled={trabajando || sala.estado === 'finalizado'}
              icono={<Square size={14} />}
              texto="Terminar"
              tono="bg-red-500/80 hover:bg-red-500"
              titulo="Finaliza y muestra el podio"
            />
            <button
              onClick={() => navigate('/admin')}
              title="Volver al panel"
              className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 hover:bg-white/15 transition text-[#B8AFD9]"
            >
              <LogOut size={15} />
            </button>
          </div>
        </header>

        {/* Conexión degradada: el juego sigue por polling/deadlines. */}
        <BannerConexion visible={degradado} texto="Conexión inestable: re-sincronizando… el juego no se detiene." />

        {/* Aviso visible de RPC fallida (antes solo iba a consola). */}
        {aviso && (
          <div className="mb-4 flex items-center justify-between gap-3 rounded-2xl border border-red-400/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-200">
            <span>{aviso}</span>
            <button
              onClick={() => setAviso(null)}
              className="rounded-full px-2 text-red-200/80 hover:text-white transition"
            >
              Cerrar
            </button>
          </div>
        )}

        <TransicionVista claveVista={vista} className="flex-1 flex flex-col">
          {sala.estado === 'en_espera' && <LobbyAnfitrion {...props} />}
          {sala.estado === 'finalizado' && (
            <div className="flex flex-1 flex-col items-center justify-center gap-8 py-6">
              <Podio jugadores={jugadores} online={online} titulo="Podio final" />
              <p className="text-xs text-[#6C6193] -mt-4">
                "Lobby" arriba reinicia todo y te deja elegir otro juego (revancha).
              </p>
            </div>
          )}
          {(sala.estado === 'jugando' || sala.estado === 'pausado') && (
            <>
              {sala.estado === 'pausado' && (
                <div className="mb-4 flex items-center justify-center gap-3 rounded-2xl border border-amber-400/50 bg-amber-400/10 px-6 py-3 text-lg font-bold text-amber-300 animate-rosco-blink">
                  <Pause size={20} /> Juego pausado
                </div>
              )}
              {sala.juego_actual === 'rosco' && <PanelRosco {...props} />}
              {sala.juego_actual === 'trivia' && <PanelTrivia {...props} />}
              {sala.juego_actual === 'basta' && <PanelBasta {...props} />}
              {sala.juego_actual === 'supervivencia' && <PanelSupervivencia {...props} />}
            </>
          )}
        </TransicionVista>
      </main>

      {mostrarBanco && <BancoPreguntas onCerrar={() => setMostrarBanco(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lobby: QR + PIN + jugadores + selector de juego
// ---------------------------------------------------------------------------
function LobbyAnfitrion({ sala, jugadores, online, ejecutar, trabajando }) {
  const navigate = useNavigate();
  const [juegoElegido, setJuegoElegido] = useState(sala.juego_actual || null);
  const urlUnirse = `${URL_BASE}/?sala=${sala.codigo}`;
  const [copiado, setCopiado] = useState(false);

  // Si cambia el juego de la sala, se refleja en el selector (en render).
  const [juegoPrevio, setJuegoPrevio] = useState(sala.juego_actual || null);
  if (juegoPrevio !== (sala.juego_actual || null)) {
    setJuegoPrevio(sala.juego_actual || null);
    setJuegoElegido(sala.juego_actual || null);
  }

  async function lanzar() {
    if (!juegoElegido) return;
    await ejecutar(async () => {
      await api.seleccionarJuego(sala.id, juegoElegido);
      // Cada juego tiene su propia RPC de arranque.
      if (juegoElegido === 'rosco') await api.roscoIniciar(sala.id);
      if (juegoElegido === 'trivia') await api.triviaSiguiente(sala.id);
      if (juegoElegido === 'basta') await api.bastaIniciarRonda(sala.id);
      if (juegoElegido === 'supervivencia') await api.supervivenciaSiguiente(sala.id);
    });
  }

  function copiarEnlace() {
    const marcar = () => {
      setCopiado(true);
      setTimeout(() => setCopiado(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(urlUnirse).then(marcar).catch(marcarFallback);
    } else {
      marcarFallback();
    }
    // Fallback clásico si el navegador no da permiso de clipboard.
    function marcarFallback() {
      const area = document.createElement('textarea');
      area.value = urlUnirse;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        marcar();
      } catch {
        /* sin clipboard disponible */
      }
      document.body.removeChild(area);
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-8 flex-1">
      {/* QR + PIN */}
      <section className="flex flex-col items-center gap-5 rounded-3xl border border-white/10 bg-white/[0.04] p-8">
        <div className="rounded-2xl bg-white p-4 shadow-2xl">
          <QRCodeSVG value={urlUnirse} size={220} level="M" />
        </div>
        <div className="text-center">
          <p className="text-xs uppercase tracking-[0.3em] text-[#8B80B3] font-bold mb-1">Game PIN</p>
          <p className="text-6xl font-black tracking-[0.15em] pl-[0.15em] text-amber-300">{sala.codigo}</p>
        </div>
        <button
          onClick={copiarEnlace}
          className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold text-[#B8AFD9] hover:text-white transition"
        >
          {copiado ? <Check size={13} className="text-green-400" /> : <Copy size={13} />}
          {copiado ? '¡Enlace copiado!' : 'Copiar enlace para jugar'}
        </button>
      </section>

      {/* Jugadores + selector de juego */}
      <section className="flex flex-col gap-6 min-w-0">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
            Jugadores conectados ({jugadores.length})
          </h2>
          {jugadores.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-[#6C6193]">
              Esperando que escaneen el QR e ingresen el PIN...
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-3">
              {jugadores.map((j) => (
                <div
                  key={j.id}
                  className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2.5"
                >
                  <AvatarChip
                    icono={j.icono}
                    color={j.color}
                    tamano="sm"
                    online={online.has(j.id)}
                  />
                  <span className="text-sm font-semibold truncate">{j.nickname}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex-1">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
            Elegí el juego
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Object.values(JUEGOS).map((juego) => {
              const activo = juegoElegido === juego.id;
              return (
                <button
                  key={juego.id}
                  onClick={() => setJuegoElegido(juego.id)}
                  className={`relative overflow-hidden rounded-2xl border p-4 text-left transition group ${
                    activo
                      ? 'border-amber-400/70 bg-amber-400/10'
                      : 'border-white/10 bg-white/[0.04] hover:border-white/25'
                  }`}
                >
                  <div
                    className={`absolute inset-0 bg-gradient-to-br ${juego.color} opacity-0 group-hover:opacity-10 ${activo ? 'opacity-15' : ''} transition`}
                  />
                  <div className="relative flex items-start gap-3">
                    <span className="text-2xl">{juego.emoji}</span>
                    <div className="min-w-0">
                      <p className={`font-extrabold ${juego.acento}`}>{juego.nombre}</p>
                      <p className="text-xs text-[#B8AFD9] leading-snug mt-0.5">{juego.descripcion}</p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="mt-6 flex items-center justify-between gap-4">
            <button
              onClick={() => navigate('/admin')}
              className="text-xs text-[#6C6193] hover:text-[#B8AFD9] transition"
            >
              ← Mis salas
            </button>
            <button
              onClick={lanzar}
              disabled={!juegoElegido || jugadores.length === 0 || trabajando}
              className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1B1035] font-black text-lg px-10 py-4 shadow-lg shadow-orange-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {trabajando ? <Loader2 className="animate-spin" size={20} /> : <Play size={20} />}
              ¡Lanzar!
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function BotonControl({ onClick, icono, texto, tono, disabled, titulo }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={titulo}
      className={`flex items-center gap-1.5 rounded-full px-4 py-2 text-xs font-bold transition disabled:opacity-40 disabled:cursor-not-allowed ${tono}`}
    >
      {icono}
      {texto}
    </button>
  );
}
