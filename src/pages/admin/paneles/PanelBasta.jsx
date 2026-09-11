// src/pages/admin/paneles/PanelBasta.jsx
//
// Control del BASTA / TUTTI FRUTTI:
//   escribiendo   -> letra + categorías proyectadas, palabras recibidas en
//                    vivo (broadcast) y panel para TACHAR palabras.
//   cuenta_atras  -> reloj letal rojo de 10 s + "Cerrar ahora".
//   resultados    -> tabla de palabras con únicas/repetidas/tachadas y
//                    recálculo idempotente tras cada tachadura.

import React, { useEffect, useState } from 'react';
import { Loader2, Eye, Ban, Check } from 'lucide-react';
import AnilloProgreso from '../../../components/AnilloProgreso';
import RankingJugadores from '../../../components/RankingJugadores';
import FeedBurbujas from '../../../components/FeedBurbujas';
import { useFeedBurbujas } from '../../../hooks/useFeedBurbujas';
import { useCuentaAtras } from '../../../hooks/useCuentaAtras';
import { useEventoSala } from '../../../hooks/useSalaRealtime';
import { api, consultas } from '../../../api/kaldoraApi';
import { BASTA } from '../../../game/constantes';

export default function PanelBasta({
  sala, jugadores, online, offsetReloj, escuchar, ejecutar, trabajando,
}) {
  const juego = sala.juego || {};
  const fase = juego.fase || 'escribiendo';
  const letra = juego.letra || '?';
  const categoriasIds = juego.categorias || [];
  const congelada = sala.estado === 'pausado';
  const { burbujas, push } = useFeedBurbujas();

  const [categorias, setCategorias] = useState([]);
  const [palabras, setPalabras] = useState([]);
  const [palabrasRecibidas, setPalabrasRecibidas] = useState(0);
  const [cargandoPalabras, setCargandoPalabras] = useState(false);

  const nicknamePorId = Object.fromEntries(jugadores.map((j) => [j.id, j.nickname]));

  // Nombres de categorías de la ronda.
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
        setCategorias(categoriasIds.map((id) => todas.find((c) => c.id === id)).filter(Boolean));
      })
      .catch(() => {});
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(categoriasIds)]);

  // Palabras de la ronda: al entrar en cuenta_atras (para tachar) y en
  // resultados (para la proyección). El host las lee por ser authenticated.
  useEffect(() => {
    if (fase === 'escribiendo') return;
    let vigente = true;
    setCargandoPalabras(true);
    consultas
      .respuestasBastaDeSala(sala.id)
      .then((filas) => vigente && setPalabras(filas))
      .catch(() => vigente && setPalabras([]))
      .finally(() => vigente && setCargandoPalabras(false));
    return () => {
      vigente = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fase, sala.id]);

  // Contador de palabras en vivo (broadcast, fase escribiendo) + burbujas.
  useEventoSala(escuchar, 'basta_palabra', ({ idJugador }) => {
    setPalabrasRecibidas((n) => n + 1);
    push({ texto: nicknamePorId[idJugador] || 'Jugador', nota: '✓' });
  });
  useEffect(() => {
    if (fase === 'escribiendo') setPalabrasRecibidas(0);
  }, [fase, juego.inicio]);

  // Aviso de BASTA cantado (flash con el nickname).
  const [quienCanto, setQuienCanto] = useState(null);
  useEventoSala(escuchar, 'basta_urgente', ({ nickname }) => {
    setQuienCanto(nickname);
    push({ texto: `${nickname} cantó BASTA!`, nota: '⚡' });
  });

  const { msRestantes, progreso } = useCuentaAtras({
    fin: juego.deadline,
    duracionMs: BASTA.SEGUNDOS_LETALES * 1000,
    offsetReloj,
    congelada,
  });

  async function tachar(idRespuesta, valida) {
    await ejecutar(() => api.bastaToggleValida(sala.id, idRespuesta, valida));
    setPalabras((prev) => prev.map((p) => (p.id === idRespuesta ? { ...p, valida } : p)));
  }

  const enUrgencia = fase === 'cuenta_atras';

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-8 flex-1">
      <FeedBurbujas burbujas={burbujas} />
      <div className="flex flex-col gap-5 min-w-0">
        {/* Encabezado de ronda */}
        <div
          className={`flex items-center gap-5 rounded-3xl border p-5 ${
            enUrgencia ? 'border-red-500/60 bg-red-500/10' : 'border-white/10 bg-white/[0.04]'
          }`}
        >
          <span
            className={`flex h-20 w-20 items-center justify-center rounded-2xl text-4xl font-black ${
              enUrgencia ? 'bg-red-500/20 text-red-300' : 'bg-fuchsia-500/20 text-fuchsia-300'
            }`}
          >
            {letra}
          </span>
          <div className="min-w-0 flex-1">
            {enUrgencia ? (
              <>
                <p className="text-2xl font-black text-red-300">
                  {quienCanto ? `¡${quienCanto} cantó BASTA!` : '¡Cuenta regresiva!'}
                </p>
                <p className="text-sm text-red-200/80">Los demás tienen 10 segundos</p>
              </>
            ) : (
              <>
                <p className="text-xl font-bold">Basta — todos escriben con "{letra}"</p>
                <p className="text-sm text-[#B8AFD9] mt-0.5">
                  Palabras recibidas: <span className="font-black text-fuchsia-300">{palabrasRecibidas}</span>
                  {juego.completado_por && ' · ronda en cuenta regresiva'}
                </p>
              </>
            )}
          </div>
          {enUrgencia && (
            <div className={msRestantes <= 3000 ? 'animate-pulso-reloj' : ''}>
              <AnilloProgreso
                progreso={progreso}
                tamano={92}
                grosor={9}
                texto={`${Math.ceil(msRestantes / 1000)}`}
                subtexto="seg"
              />
            </div>
          )}
        </div>

        {/* Categorías proyectadas */}
        {fase !== 'resultados' && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {categorias.map((c) => (
              <div
                key={c.id}
                className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-5 text-center"
              >
                <p className="text-xs uppercase tracking-wider text-[#8B80B3] font-bold">{c.nombre}</p>
                <p className="text-2xl font-black text-fuchsia-300 mt-1">{letra}...</p>
              </div>
            ))}
          </div>
        )}

        {/* Controles según fase */}
        {fase !== 'resultados' && (
          <div className="flex flex-wrap items-center gap-3">
            <button
              onClick={() => ejecutar(() => api.bastaCerrarRonda(sala.id))}
              disabled={trabajando || congelada}
              className="flex items-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-purple-500 text-white font-black px-8 py-4 shadow-lg shadow-fuchsia-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40"
            >
              {trabajando ? <Loader2 className="animate-spin" size={18} /> : <Ban size={18} />}
              {enUrgencia ? 'Cerrar ronda ahora' : 'Cerrar ronda'}
            </button>
            <p className="text-xs text-[#6C6193] max-w-xl">
              Al cerrar: única +10 · repetida +5 · tachada 0 — vos decidís.
              El diccionario marca en naranja/ámbar las palabras dudosas, pero son solo avisos:
              si son correctas puntúan igual; tachá solo lo que no valga y recalculá.
            </p>
          </div>
        )}

        {/* Tachado / resultados */}
        {(fase === 'cuenta_atras' || fase === 'resultados') && (
          <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-[10px] uppercase tracking-widest text-[#8B80B3] font-bold">
                {fase === 'resultados' ? 'Resultados de la ronda' : 'Palabras recibidas — tachá las inválidas'}
              </p>
              {fase === 'resultados' && (
                <button
                  onClick={() => ejecutar(() => api.bastaCerrarRonda(sala.id))}
                  disabled={trabajando}
                  className="flex items-center gap-1.5 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-[11px] font-bold text-[#B8AFD9] hover:bg-white/15 transition disabled:opacity-40"
                >
                  {trabajando ? <Loader2 className="animate-spin" size={12} /> : <Check size={12} />}
                  Recalcular puntajes
                </button>
              )}
            </div>

            {cargandoPalabras ? (
              <p className="flex items-center gap-2 py-4 text-sm text-[#B8AFD9]">
                <Loader2 className="animate-spin" size={15} /> Buscando palabras...
              </p>
            ) : palabras.length === 0 ? (
              <p className="py-4 text-sm text-[#6C6193]">Sin palabras todavía.</p>
            ) : (
              <div className="flex flex-col gap-3 max-h-[380px] overflow-y-auto pr-1">
                {categorias.map((cat) => {
                  const deCategoria = palabras.filter((p) => p.id_categoria === cat.id);
                  if (deCategoria.length === 0) return null;
                  return (
                    <div key={cat.id}>
                      <p className="text-[11px] font-black uppercase tracking-wider text-fuchsia-300 mb-1">
                        {cat.nombre}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {deCategoria.map((p) => (
                          <span
                            key={p.id}
                            className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold border transition ${
                              !p.valida
                                ? 'border-red-400/40 bg-red-500/15 text-red-300 line-through'
                                : p.existe === false
                                  ? 'border-orange-400/40 bg-orange-500/15 text-orange-200'
                                  : p.corresponde === false
                                    ? 'border-amber-400/40 bg-amber-500/15 text-amber-200'
                                    : p.unico === true
                                      ? 'border-green-400/40 bg-green-500/15 text-green-200'
                                      : p.unico === false
                                        ? 'border-white/10 bg-white/5 text-white/70'
                                        : 'border-white/10 bg-white/5 text-white/80'
                            }`}
                          >
                            {nicknamePorId[p.id_jugador] || 'Jugador'}:
                            <span className="font-black">{p.texto?.trim() || '—'}</span>
                            <button
                              onClick={() => tachar(p.id, !p.valida)}
                              title={p.valida ? 'Tachar (invalidar)' : 'Validar de nuevo'}
                              className="ml-1 rounded-full bg-black/20 p-0.5 hover:bg-black/40"
                            >
                              {p.valida ? <Ban size={11} /> : <Check size={11} />}
                            </button>
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {fase === 'resultados' && (
          <button
            onClick={() => ejecutar(() => api.bastaIniciarRonda(sala.id))}
            disabled={trabajando || congelada}
            className="flex items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-fuchsia-500 to-purple-500 text-white font-black text-lg px-10 py-4 shadow-lg shadow-fuchsia-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-40"
          >
            {trabajando ? <Loader2 className="animate-spin" size={20} /> : <Eye size={20} />}
            Nueva ronda (nueva letra)
          </button>
        )}
      </div>

      <div className="min-w-0">
        <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
          Ranking en vivo
        </h2>
        <RankingJugadores jugadores={jugadores} online={online} compacto />
      </div>
    </div>
  );
}
