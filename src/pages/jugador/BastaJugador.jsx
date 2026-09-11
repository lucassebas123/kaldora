// src/pages/jugador/BastaJugador.jsx
//
// BASTA / TUTTI FRUTTI: letra común + 5 categorías.
//   * fase 'escribiendo': cada uno completa sus 5 palabras.
//   * Quien termina primero (RPC basta_declarar_completo) dispara la cuenta
//     regresiva LETAL de 10 s para la sala (broadcast 'basta_urgente').
//   * fase 'cuenta_atras': los demás corren; al vencer el deadline cualquiera
//     cierra (RPC idempotente) y el servidor premia palabras únicas (10) y
//     repetidas (5).
//   * fase 'resultados': cada uno ve su tabla de palabras y puntos; el host
//     puede lanzar otra ronda o terminar.

import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Zap } from 'lucide-react';
import AnilloProgreso from '../../components/AnilloProgreso';
import { useCuentaAtras } from '../../hooks/useCuentaAtras';
import { api, consultas } from '../../api/kaldoraApi';
import { BASTA } from '../../game/constantes';
import { sonarAlarma, sonarAcierto, sonarTicTac } from '../../utils/sonidos';
import { vibrarUrgencia, vibrarCelebracion } from '../../utils/haptico';
import { confetiRafaga } from '../../utils/confeti';
import { useEventoSala } from '../../hooks/useSalaRealtime';

export default function BastaJugador({
  sala,
  sesion,
  offsetReloj,
  escuchar,
  enviar,
}) {
  const juego = sala.juego || {};
  const fase = juego.fase || 'escribiendo';
  const letra = juego.letra || '?';
  const categoriasIds = juego.categorias || [];
  const congelada = sala.estado === 'pausado';

  const [categorias, setCategorias] = useState([]); // [{id, nombre}]
  const [palabras, setPalabras] = useState({}); // {idCategoria: texto}
  const [guardadas, setGuardadas] = useState({}); // {idCategoria: true}
  const [resultado, setResultado] = useState(null); // resultados de la ronda cerrada
  const [soyElPrimero, setSoyElPrimero] = useState(false);
  const [urgencia, setUrgencia] = useState(null); // {nickname}
  const [enviando, setEnviando] = useState(false);
  const declaradoRef = useRef(false);

  // Categorías de la ronda (nombres por id).
  useEffect(() => {
    if (categoriasIds.length === 0) {
      setCategorias([]);
      return;
    }
    let vigente = true;
    consultas
      .categoriasBasta()
      .then((todas) => {
        if (!vigente) return;
        const filtradas = categoriasIds
          .map((id) => todas.find((c) => c.id === id))
          .filter(Boolean);
        setCategorias(filtradas);
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(categoriasIds)]);

  // Nueva ronda: reset local.
  useEffect(() => {
    setPalabras({});
    setGuardadas({});
    setResultado(null);
    setSoyElPrimero(false);
    setUrgencia(null);
    declaradoRef.current = false;
  }, [letra, fase === 'escribiendo' && juego.inicio]); // eslint-disable-line react-hooks/exhaustive-deps

  // Resultados cuando la ronda cierra.
  useEffect(() => {
    if (fase !== 'resultados' || !sesion?.idJugador) return;
    consultas
      .misRespuestasBasta(sesion.idJugador)
      .then((filas) => {
        const mias = filas.filter((f) => categoriasIds.includes(f.id_categoria));
        setResultado(mias);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fase, sesion?.idJugador, JSON.stringify(categoriasIds)]);

  // Cuenta regresiva letal.
  const { msRestantes, progreso } = useCuentaAtras({
    fin: juego.deadline,
    duracionMs: BASTA.SEGUNDOS_LETALES * 1000,
    offsetReloj,
    congelada,
  });

  useEffect(() => {
    if (congelada || fase !== 'cuenta_atras') return;
    if (msRestantes > 0 && msRestantes <= 3000) sonarTicTac();
  }, [Math.ceil(msRestantes / 500), fase, congelada]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al vencer el deadline, cualquiera cierra (idempotente en el servidor).
  useEffect(() => {
    if (congelada || fase !== 'cuenta_atras') return;
    if (msRestantes > 0) return;
    api.bastaCerrarRonda(sala.id).catch(() => {});
  }, [msRestantes, fase, congelada, sala.id]);

  // Aviso de que alguien completó (broadcast).
  useEventoSala(escuchar, 'basta_urgente', ({ nickname, idJugador }) => {
    if (idJugador === sesion.idJugador) return;
    setUrgencia({ nickname });
    sonarAlarma();
    vibrarUrgencia();
  });

  const completadas = categorias.filter((c) => (palabras[c.id] || '').trim()).length;

  async function guardarPalabra(idCategoria, valor) {
    const texto = valor.trim();
    if (guardadas[idCategoria] && palabras[idCategoria] === valor) return;
    setPalabras((p) => ({ ...p, [idCategoria]: valor }));
    if (!texto) return;
    try {
      await api.bastaEnviar(idCategoria, texto);
      setGuardadas((g) => ({ ...g, [idCategoria]: true }));
      // Aviso volado al panel del anfitrión (contador de palabras en vivo).
      enviar('basta_palabra', { idJugador: sesion.idJugador, idCategoria });
    } catch (err) {
      if (String(err.message).includes('cerró el tiempo') || String(err.message).includes('no acepta')) {
        // La ronda ya cerró: la UI muta sola por el cambio de fase.
      }
    }
  }

  async function declararBasta() {
    if (declaradoRef.current || completadas < BASTA.CATEGORIAS) return;
    declaradoRef.current = true;
    setEnviando(true);
    try {
      const res = await api.bastaDeclararCompleto();
      if (res.soyPrimero) {
        setSoyElPrimero(true);
        sonarAcierto();
        confetiRafaga({ y: 0.35 });
        vibrarCelebracion();
        enviar('basta_urgente', { nickname: sesion.nickname, idJugador: sesion.idJugador });
      }
    } catch {
      declaradoRef.current = false;
    } finally {
      setEnviando(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Vista de resultados
  // ---------------------------------------------------------------------------
  if (fase === 'resultados') {
    const puntosRonda = (resultado || []).reduce((acc, r) => acc + (r.puntos || 0), 0);
    return (
      <div className="flex flex-col gap-4 flex-1">
        <div className="rounded-2xl border border-amber-400/40 bg-amber-400/10 p-4 text-center">
          <p className="text-xs uppercase tracking-widest text-amber-300 font-bold">Ronda cerrada</p>
          <p className="text-2xl font-black text-amber-200 mt-1">
            {puntosRonda > 0 ? `+${puntosRonda} pts` : 'Sin puntos esta ronda'}
          </p>
          {urgencia && (
            <p className="text-xs text-[#B8AFD9] mt-1">La cantó primero: {urgencia.nickname}</p>
          )}
        </div>

        <div className="flex flex-col gap-2">
          {categorias.map((cat) => {
            const fila = (resultado || []).find((r) => r.id_categoria === cat.id);
            const texto = fila?.texto?.trim() || '—';
            return (
              <div
                key={cat.id}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5"
              >
                <span className="text-xs font-bold text-[#8B80B3] w-28 shrink-0 truncate">{cat.nombre}</span>
                <span className="flex-1 text-sm font-semibold truncate">{texto}</span>
                {fila && (
                  <span
                    title={
                      fila.existe === false
                        ? 'El diccionario no la reconoce: el anfitrión puede revisarla'
                        : fila.corresponde === false
                          ? 'El léxico no la asocia a la categoría: el anfitrión puede revisarla'
                          : undefined
                    }
                    className={`text-[10px] font-black uppercase px-2 py-0.5 rounded-full ${
                      !fila.valida
                        ? 'bg-red-500/20 text-red-300'
                        : fila.unico
                          ? 'bg-green-500/20 text-green-300'
                          : 'bg-white/10 text-[#B8AFD9]'
                    }`}
                  >
                    {!fila.valida ? 'tachada' : fila.unico ? 'única +10' : 'repetida +5'}
                    {fila.valida && (fila.existe === false || fila.corresponde === false) ? ' ⚠' : ''}
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <p className="text-center text-xs text-[#6C6193]">
          El anfitrión puede lanzar otra letra o cerrar el juego.
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Vista de juego (escribiendo / cuenta_atras)
  // ---------------------------------------------------------------------------
  const enUrgencia = fase === 'cuenta_atras';

  return (
    <div className="flex flex-col gap-4 flex-1">
      {/* Encabezado de ronda */}
      <div
        className={`flex items-center gap-4 rounded-2xl border p-4 transition ${
          enUrgencia
            ? 'border-red-500/60 bg-red-500/10 animate-pop'
            : 'border-white/10 bg-white/[0.04]'
        }`}
      >
        <span
          className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-3xl font-black ${
            enUrgencia ? 'bg-red-500/20 text-red-300' : 'bg-fuchsia-500/20 text-fuchsia-300'
          }`}
        >
          {letra}
        </span>
        <div className="min-w-0 flex-1">
          {enUrgencia ? (
            <>
              <p className="text-sm font-black text-red-300">
                {soyElPrimero ? '¡CANTASTE BASTA! 🎉' : urgencia ? `¡${urgencia.nickname} cantó BASTA!` : '¡Cuenta regresiva!'}
              </p>
              <p className="text-xs text-red-200/80">10 segundos para terminar</p>
            </>
          ) : (
            <>
              <p className="text-sm font-bold">Completá las 5 categorías</p>
              <p className="text-xs text-[#B8AFD9]">
                Empiezan con <span className="font-black text-fuchsia-300">{letra}</span> · únicas +10
              </p>
            </>
          )}
        </div>
        {enUrgencia && (
          <div className={msRestantes <= 3000 ? 'animate-pulso-reloj' : ''}>
            <AnilloProgreso
              progreso={progreso}
              tamano={64}
              grosor={6}
              texto={`${Math.ceil(msRestantes / 1000)}`}
              subtexto="seg"
            />
          </div>
        )}
      </div>

      {/* Progreso */}
      <div className="flex items-center gap-2">
        {categorias.map((c) => (
          <span
            key={c.id}
            className={`h-1.5 flex-1 rounded-full transition ${
              (palabras[c.id] || '').trim() ? 'bg-fuchsia-400' : 'bg-white/10'
            }`}
            title={c.nombre}
          />
        ))}
        <span className="text-xs font-bold text-[#B8AFD9] tabular-nums ml-1">
          {completadas}/{categorias.length}
        </span>
      </div>

      {/* Inputs por categoría */}
      <div className="flex flex-col gap-2">
        {categorias.map((cat) => (
          <div key={cat.id} className="relative">
            <input
              value={palabras[cat.id] || ''}
              onChange={(e) => setPalabras((p) => ({ ...p, [cat.id]: e.target.value.slice(0, 40) }))}
              onBlur={(e) => guardarPalabra(cat.id, e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && guardarPalabra(cat.id, e.target.value)}
              disabled={congelada || (enUrgencia && msRestantes <= 0)}
              placeholder={cat.nombre}
              autoComplete="off"
              className="w-full h-12 rounded-xl bg-white/[0.06] border border-white/10 pl-4 pr-10 text-base font-semibold outline-none focus:border-fuchsia-400/70 transition disabled:opacity-40 placeholder:font-normal placeholder:text-sm placeholder:text-[#6C6193]"
            />
            {guardadas[cat.id] && (
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-green-400 text-xs font-black">✓</span>
            )}
          </div>
        ))}
      </div>

      {/* Botón BASTA */}
      <button
        type="button"
        onClick={declararBasta}
        disabled={completadas < categorias.length || enviando || enUrgencia || congelada}
        className={`h-14 rounded-2xl font-black text-lg flex items-center justify-center gap-2 transition active:scale-[0.98] disabled:opacity-30 disabled:cursor-not-allowed ${
          completadas >= categorias.length && !enUrgencia
            ? 'bg-gradient-to-r from-fuchsia-500 to-purple-500 text-white shadow-lg shadow-fuchsia-500/30 animate-pulse'
            : 'bg-white/[0.06] border border-white/10 text-[#B8AFD9]'
        }`}
      >
        {enviando ? <Loader2 className="animate-spin" size={20} /> : <Zap size={20} />}
        ¡BASTA!
      </button>
    </div>
  );
}
