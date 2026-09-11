// src/hooks/useSalaRealtime.js
//
// Hook central de tiempo real para TODA la plataforma (jugador y anfitrión).
//
// Un único canal por sala transporta:
//   1. postgres_changes de 'salas'   -> estado global (estado, juego_actual, juego)
//   2. postgres_changes de 'jugadores' -> puntajes/racha/eliminado en vivo
//   3. PRESENCE -> quién está conectado ahora (jugadores y anfitrión)
//   4. BROADCAST 'ev' -> eventos de alta frecuencia SIN escribir la base
//      (respuestas voladas, "¡completé el Basta!", avisos del host).
//   5. BROADCAST 'hora_req'/'hora_res' -> sincronización de reloj. Cada cliente
//      mide la deriva respecto al anfitrión para que los cuenta-atrás de
//      15 s / 10 s / 20 s corran parejos en todos los dispositivos.
//
// Uso:
//   const { sala, jugadores, online, offsetReloj, listo, broadcast, enviar } =
//     useSalaRealtime(idSala, { sesionJugador, esAnfitrion });
//
// - `broadcast` es un emitter local para que la UI escuche eventos 'ev'
//   sin re-crear canales (lo consume useEventoSala).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
/** Ordena jugadores: 1º puntos, 2º menos eliminados (vivos arriba), 3º racha. */
function ordenarJugadores(jugadores) {
  return [...jugadores].sort((a, b) => {
    if (b.puntos !== a.puntos) return b.puntos - a.puntos;
    if (a.eliminado !== b.eliminado) return a.eliminado ? 1 : -1;
    if (b.racha !== a.racha) return b.racha - a.racha;
    return (a.nickname || '').localeCompare(b.nickname || '');
  });
}

/**
 * Emisor sencillo de eventos broadcast para la UI (patrón pub/sub local).
 */
export function crearEmisor() {
  const oyentes = new Map(); // tipo -> Set(fn)
  return {
    on(tipo, fn) {
      if (!oyentes.has(tipo)) oyentes.set(tipo, new Set());
      oyentes.get(tipo).add(fn);
      return () => oyentes.get(tipo)?.delete(fn);
    },
    emit(tipo, payload) {
      oyentes.get(tipo)?.forEach((fn) => fn(payload));
    },
  };
}

export function useSalaRealtime(idSala, { sesionJugador = null, esAnfitrion = false } = {}) {
  const [sala, setSala] = useState(null);
  const [jugadores, setJugadores] = useState([]);
  const [online, setOnline] = useState(() => new Set());
  const [listo, setListo] = useState(false);
  const [error, setError] = useState(null);
  // La sala fue VERIFICADA contra la base (recargar completó): con esto se
  // distingue "todavía cargando" (sala null transitorio) de "sala inexistente".
  const [verificada, setVerificada] = useState(false);
  // Deriva (ms) del reloj local respecto al anfitrión: horaAnfitrion ≈ local + offset.
  const [offsetReloj, setOffsetReloj] = useState(0);

  const canalRef = useRef(null);
  // Emitter local de eventos broadcast para la UI (estable entre renders).
  const emisor = useMemo(() => crearEmisor(), []);
  const tokenRef = useRef(null);
  const esAnfitrionRef = useRef(false);
  const trackeadoRef = useRef(false);
  const ultimoEventoRef = useRef(Date.now());

  // Sincroniza los refs fuera del render (regla de refs de React).
  useEffect(() => {
    tokenRef.current = sesionJugador?.token || null;
  }, [sesionJugador?.token]);
  useEffect(() => {
    esAnfitrionRef.current = esAnfitrion;
  }, [esAnfitrion]);

  // ---------------------------------------------------------------------------
  // Carga inicial / re-sincronización (polling de respaldo cada 3 s: los
  // relojes son por deadline y los eventos de broadcast dan el golpe seco,
  // así que el juego funciona aunque Realtime entregue tarde o nunca).
  // Devuelve el estado cargado para que el anfitrión lo pueda re-difundir.
  // ---------------------------------------------------------------------------
  const recargar = useCallback(async () => {
    if (!idSala) return null;
    const [resSala, resJugadores] = await Promise.all([
      supabase.from('salas').select('*').eq('id', idSala).maybeSingle(),
      supabase.from('jugadores').select('*').eq('id_sala', idSala),
    ]);
    if (resSala.error || resJugadores.error) {
      setError(resSala.error || resJugadores.error);
    }
    setSala(resSala.data);
    setJugadores(ordenarJugadores(resJugadores.data || []));
    setListo(true);
    setVerificada(true);
    return { sala: resSala.data, jugadores: ordenarJugadores(resJugadores.data || []) };
  }, [idSala]);

  // ---------------------------------------------------------------------------
  // Presencia: track del propio cliente
  // ---------------------------------------------------------------------------
  const trackear = useCallback(async () => {
    const canal = canalRef.current;
    if (!canal || canal.state !== 'joined' || trackeadoRef.current) return;

    if (esAnfitrionRef.current) {
      await canal.track({ tipo: 'anfitrion' });
      trackeadoRef.current = true;
      return;
    }
    if (tokenRef.current) {
      const sesion = JSON.parse(localStorage.getItem('kaldora_jugador') || 'null');
      await canal.track({
        tipo: 'jugador',
        id: sesion?.idJugador,
        nickname: sesion?.nickname,
        icono: sesion?.icono,
        color: sesion?.color,
      });
      trackeadoRef.current = true;
    }
  }, []);

  const sincronizarPresencia = useCallback(() => {
    const canal = canalRef.current;
    if (!canal) return;
    const estado = canal.presenceState();
    const ids = new Set();
    Object.values(estado).forEach((lista) => {
      (Array.isArray(lista) ? lista : [lista]).forEach((p) => {
        if (p?.id) ids.add(p.id);
      });
    });
    // El propio canal no devuelve el eco del propio cliente: marcarse a sí
    // mismo como online (un jugador siempre sabe que está conectado).
    try {
      const sesion = JSON.parse(localStorage.getItem('kaldora_jugador') || 'null');
      if (sesion?.idJugador) ids.add(sesion.idJugador);
    } catch {
      /* sin sesión: es el anfitrión, nada que sumar */
    }
    setOnline(ids);
  }, []);

  // ---------------------------------------------------------------------------
  // Sincronía de reloj: los clientes miden su deriva contra el anfitrión.
  // offset = t_anfitrion + rtt/2 - t_local  (muestreo con mínimo RTT)
  // ---------------------------------------------------------------------------
  const pingReloj = useCallback(() => {
    const canal = canalRef.current;
    if (!canal || esAnfitrionRef.current) return;
    canal.send({
      type: 'broadcast',
      event: 'hora_req',
      payload: { t: Date.now(), de: tokenRef.current },
    });
  }, []);

  useEffect(() => {
    if (!idSala) return;

    recargar();

    // Sin `filter` de postgres_changes: la entrega filtrada de Realtime es
    // intermitente (entrega 1 evento y enmudece). Filtramos en el cliente y
    // un vigilante re-sincroniza si el canal queda mudo.
    const marcarEvento = () => {
      ultimoEventoRef.current = Date.now();
    };

    // Reconexión. El canal usa un NOMBRE DETERMINISTA compartido por toda la
    // sala (`sala:{id}`): broadcast y presence solo cruzan entre clientes que
    // están en el MISMO topic. Con un sufijo por cliente (p.ej. Date.now())
    // cada uno quedaba aislado en su propio canal y el host nunca recibía los
    // avisos de los jugadores (contadores, "¡BASTA!", reloj).
    // Antes de reconstruir se espera el removeChannel del canal anterior para
    // no pisar dos suscripciones con el mismo topic en la misma conexión.
    let conectando = false;
    let desmontado = false;
    const conectar = async () => {
      if (conectando) return;
      conectando = true;
      try {
        const previo = canalRef.current;
        canalRef.current = null;
        if (previo) {
          try {
            await supabase.removeChannel(previo);
          } catch {
            /* ya removido o sin conexión */
          }
        }
        if (desmontado) return;

        const canal = supabase
        .channel(`sala:${idSala}`, {
          config: { presence: { key: tokenRef.current || `host-${idSala}` } },
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'salas' }, (payload) => {
          marcarEvento();
          const fila = payload.new;
          if (!fila || fila.id !== idSala) return;
          if (payload.eventType === 'DELETE') setSala(null);
          else setSala(fila);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'jugadores' }, (payload) => {
          marcarEvento();
          const fila = payload.eventType === 'DELETE' ? payload.old : payload.new;
          if (!fila || fila.id_sala !== idSala) return;
          setJugadores((prev) => {
            let siguiente = prev;
            if (payload.eventType === 'INSERT') {
              siguiente = prev.some((j) => j.id === fila.id) ? prev : [...prev, fila];
            } else if (payload.eventType === 'UPDATE') {
              siguiente = prev.map((j) => (j.id === fila.id ? fila : j));
            } else if (payload.eventType === 'DELETE') {
              siguiente = prev.filter((j) => j.id !== fila.id);
            }
            return ordenarJugadores(siguiente);
          });
        })
        .on('presence', { event: 'sync' }, () => {
          marcarEvento();
          sincronizarPresencia();
        })
        .on('presence', { event: 'join' }, () => {
          marcarEvento();
          sincronizarPresencia();
        })
        .on('presence', { event: 'leave' }, () => {
          marcarEvento();
          sincronizarPresencia();
        })
        .on('broadcast', { event: 'ev' }, ({ payload }) => {
          marcarEvento();
          // Instantánea de estado publicada por el anfitrión (vía rápida).
          if (payload?.tipo === 'sala' && payload.idSala === idSala) {
            if (payload.sala) setSala(payload.sala);
            if (payload.jugadores) setJugadores(ordenarJugadores(payload.jugadores));
            return;
          }
          emisor.emit(payload?.tipo, payload);
        })
        // Reloj: el anfitrión responde con SU marca de tiempo.
        .on('broadcast', { event: 'hora_req' }, ({ payload }) => {
          if (!esAnfitrionRef.current) return;
          canal.send({
            type: 'broadcast',
            event: 'hora_res',
            payload: { tReq: payload?.t, tServer: Date.now(), de: payload?.de },
          });
        })
        .on('broadcast', { event: 'hora_res' }, ({ payload }) => {
          if (payload?.de !== tokenRef.current) return;
          const rtt = Date.now() - payload.tReq;
          if (rtt > 1500) return; // muestra podrida (pestaña en background): descartar
          const offset = payload.tServer + rtt / 2 - Date.now();
          setOffsetReloj((prev) => (prev === 0 ? offset : prev * 0.3 + offset * 0.7));
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            setListo(true);
            await trackear();
            sincronizarPresencia();
            pingReloj();
          }
        });

        canalRef.current = canal;
      } finally {
        conectando = false;
      }
    };

    conectar();

    // Muestras periódicas de reloj mientras la pestaña viva (solo clientes).
    const intervaloReloj = setInterval(() => {
      if (!esAnfitrionRef.current) pingReloj();
    }, 2500);

    // VIGILANTE: si el canal queda mudo con la partida activa, re-sincroniza
    // el estado y reconstruye el canal (Realtime puede dejar de entregar).
    const vigilante = setInterval(() => {
      const silencio = Date.now() - ultimoEventoRef.current;
      if (silencio > 12000) {
        ultimoEventoRef.current = Date.now();
        recargar();
        if (esAnfitrionRef.current) return; // el anfitrión reacciona al estado poll
        // Con partida activa reconstruimos el canal para no perder el juego.
        setSala((salaActual) => {
          if (salaActual && (salaActual.estado === 'jugando' || salaActual.estado === 'pausado')) {
            conectar();
          }
          return salaActual;
        });
      }
    }, 5000);

    // POLLING base de respaldo: cada 3 s, para todos. Barato e infalible.
    const intervaloPolling = setInterval(() => {
      recargar();
    }, 3000);

    return () => {
      desmontado = true;
      clearInterval(intervaloReloj);
      clearInterval(vigilante);
      clearInterval(intervaloPolling);
      // Remueve el canal vigente y cualquier reconexión en vuelo del mismo
      // topic (la reconexión es asíncrona y puede crear uno tras el unmount).
      supabase
        .getChannels()
        .filter((c) => c.topic === `sala:${idSala}`)
        .forEach((c) => supabase.removeChannel(c));
      canalRef.current = null;
      trackeadoRef.current = false;
      setOnline(new Set());
    };
  }, [idSala, recargar, sincronizarPresencia, trackear, pingReloj, emisor]);

  // Re-trackear cuando el jugador consigue su sesión (join tardío).
  useEffect(() => {
    trackeadoRef.current = false;
    trackear();
  }, [sesionJugador?.token, trackear]);

  /** Publica un evento broadcast a toda la sala (cero escrituras). */
  const enviar = useCallback((tipo, payload = {}) => {
    canalRef.current?.send({
      type: 'broadcast',
      event: 'ev',
      payload: { tipo, ...payload },
    });
  }, []);

  /**
   * El ANFITRIÓN re-publica la instantánea completa (sala + jugadores)
   * después de cada acción: los celulares la aplican al instante por
   * broadcast sin depender de la entrega de postgres_changes.
   */
  const publicarEstado = useCallback(async () => {
    const data = await recargar();
    if (!data) return null;
    enviar('sala', { idSala, sala: data.sala, jugadores: data.jugadores });
    return data;
  }, [recargar, enviar, idSala]);

  /** Suscripción local a eventos 'ev' (estable entre renders). */
  const escuchar = useCallback((tipo, fn) => emisor.on(tipo, fn), [emisor]);

  return {
    sala,
    jugadores,
    online,
    listo,
    verificada,
    error,
    offsetReloj,
    recargar,
    enviar,
    publicarEstado,
    escuchar,
  };
}

/**
 * Suscripción local a un tipo de evento broadcast de la sala.
 *   useEventoSala(escuchar, 'basta_completo', (payload) => {...})
 */
export function useEventoSala(escuchar, tipo, callback) {
  const ref = useRef(callback);
  useEffect(() => {
    ref.current = callback;
  }, [callback]);
  useEffect(() => {
    if (!escuchar) return undefined;
    return escuchar(tipo, (payload) => ref.current(payload));
  }, [escuchar, tipo]);
}
