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
//   5. RELOJ por REST: `hora_servidor` calibra el offset local al empezar la
//      partida (y cada 5 min) para que los cuenta-atrás corran parejos sin
//      gastar un solo mensaje de Realtime.
//
// Uso:
//   const { sala, jugadores, online, offsetReloj, listo, broadcast, enviar } =
//     useSalaRealtime(idSala, { sesionJugador, esAnfitrion });
//
// - `broadcast` es un emitter local para que la UI escuche eventos 'ev'
//   sin re-crear canales (lo consume useEventoSala).
//
// PRESUPUESTO DE MENSAJES (medido 2026-09-12 con scripts/test-carga-3-salas):
//   * postgres_changes con FILTRO server-side por sala: verificado contra la
//     base real (3 salas × 20, 0 eventos ajenos, 0 entregas perdidas). Antes
//     cada cambio de cualquier sala se entregaba a todos los clientes.
//   * ping de reloj ADAPTATIVO: ráfaga inicial de 2 muestras al empezar la
//     partida y después 1 cada 90 s. Antes: 1 cada 2.5 s por jugador, que con
//     3 salas × 20 medía ~870 msg/s solo de reloj (el plan Free permite 100).
//   * polling de respaldo más lento fuera de partida (9 s en lobby vs 3 s).

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';
import { leerSesionJugador, api } from '../api/kaldoraApi';

// Reloj por REST: UNA muestra de calibración al empezar la partida (si el
// offset está vencido) y después 1 cada 5 minutos. La deriva de un celular es
// de milisegundos por minuto: con esta cadencia los cuenta-atrás de 10-20 s
// quedan parejos y NO se gasta cuota de Realtime (antes: ping/pong por
// broadcast cada 2.5 s por jugador = ~870 msg/s con 3 salas × 20).
const PING_MS_CALIBRACION = 1500;
const PING_MS_ESTABLE = 300000;
const PING_MS_REINTENTO = 5000; // backoff si la muestra falla (sin red)
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
  // `degradado` = Realtime dejó de entregar (canal mudo > 12 s) o no hay red.
  // La UI lo muestra; el polling y los deadlines del servidor siguen
  // corrigiendo el estado solo, sin perder puntajes.
  const [degradado, setDegradado] = useState(false);
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
  const ultimoEventoRef = useRef(0);
  // Reloj adaptativo: se calibra al empezar la partida (una muestra) y se
  // refresca cada 5 minutos. `ultimaRespuestaRef` evita recalibrar de nuevo en
  // partidas consecutivas dentro de la misma sesión.
  const ultimoPingRef = useRef(0);
  const ultimaRespuestaRef = useRef(0);
  const calibrarPendienteRef = useRef(true);
  const juegoActivoRef = useRef(false);
  // Último `sala` visto, para el vigilante (evita side effects en updaters).
  const salaRef = useRef(null);
  // Último cambio REAL de estado (salas/jugadores o snapshot del host): si
  // Realtime está entregando, el polling de respaldo se saltea y una sala con
  // 20-30 jugadores no genera consultas de más. Si el canal enmudece, el
  // contador envejece y el polling vuelve solo.
  const ultimoEstadoRef = useRef(0);
  // Nº de la última petición de `recargar`: descarta respuestas fuera de orden.
  const peticionRef = useRef(0);

  // Sincroniza los refs fuera del render (regla de refs de React).
  useEffect(() => {
    tokenRef.current = sesionJugador?.token || null;
  }, [sesionJugador?.token]);
  useEffect(() => {
    esAnfitrionRef.current = esAnfitrion;
  }, [esAnfitrion]);
  useEffect(() => {
    salaRef.current = sala;
    const jugando = sala?.estado === 'jugando';
    // Al arrancar una partida (transición a 'jugando') se calibra el reloj SOLO
    // si el offset está vencido (o nunca se midió); si no, se reutiliza el de
    // la partida anterior y no se envía ni un mensaje extra.
    if (jugando && !juegoActivoRef.current) {
      if (Date.now() - ultimaRespuestaRef.current > PING_MS_ESTABLE) {
        calibrarPendienteRef.current = true;
        ultimoPingRef.current = 0;
      }
    }
    juegoActivoRef.current = jugando;
  }, [sala]);

  // Suelta TODOS los canales de esta sala antes de crear uno nuevo.
  // `supabase.channel(topic)` REUTILIZA el canal existente con el mismo topic
  // (y el topic real del cliente lleva el prefijo `realtime:`); si queda uno
  // suscrito, agregar `postgres_changes` explota ("after subscribe()") y el
  // tiempo real de esa sala queda muerto hasta recargar. Pasa en remontajes
  // (StrictMode, salir y volver a la misma sala), por eso el filtro cubre las
  // dos formas del topic.
  const limpiarCanalesDeSala = useCallback(async () => {
    const candidatos = supabase
      .getChannels()
      .filter((c) => c.topic === `realtime:sala:${idSala}` || c.topic === `sala:${idSala}`);
    for (const canal of candidatos) {
      try {
        await supabase.removeChannel(canal);
      } catch {
        /* ya removido o sin conexión */
      }
    }
  }, [idSala]);

  // ---------------------------------------------------------------------------
  // Carga inicial / re-sincronización (polling de respaldo cada 3 s: los
  // relojes son por deadline y los eventos de broadcast dan el golpe seco,
  // así que el juego funciona aunque Realtime entregue tarde o nunca).
  // Devuelve el estado cargado para que el anfitrión lo pueda re-difundir.
  // ---------------------------------------------------------------------------
  const recargar = useCallback(async () => {
    if (!idSala) return null;
    const peticion = ++peticionRef.current;
    const [resSala, resJugadores] = await Promise.all([
      // Columnas explícitas: anon ya no tiene SELECT sobre id_anfitrion.
      supabase
        .from('salas')
        .select('id, codigo, estado, juego_actual, juego, creado_en')
        .eq('id', idSala)
        .maybeSingle(),
      supabase.from('jugadores').select('*').eq('id_sala', idSala),
    ]);
    // Respuesta fuera de orden (una petición vieja resolvió tarde): descartar.
    if (peticion !== peticionRef.current) return null;
    if (resSala.error || resJugadores.error) {
      setError(resSala.error || resJugadores.error);
      setListo(true);
      setVerificada(true);
      return null;
    }
    // Éxito: limpiar un error transitorio y recién ahí pisar el estado.
    setError(null);
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
      const sesion = leerSesionJugador();
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
    const sesion = leerSesionJugador();
    if (sesion?.idJugador) ids.add(sesion.idJugador);
    setOnline(ids);
  }, []);

  // ---------------------------------------------------------------------------
  // Sincronía de reloj: los clientes miden su deriva contra el anfitrión.
  // offset = t_anfitrion + rtt/2 - t_local  (muestreo con mínimo RTT)
  // ---------------------------------------------------------------------------
  const sincronizarReloj = useCallback(async () => {
    // Fuera de partida no hay cuenta atrás que calibrar y con la pestaña
    // oculta nadie ve el reloj: no se consulta nada.
    if (!juegoActivoRef.current) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    ultimoPingRef.current = Date.now();
    try {
      const t0 = Date.now();
      const ts = await api.horaServidor();
      const t1 = Date.now();
      const tServidor = new Date(ts).getTime();
      if (!Number.isFinite(tServidor)) return;
      // offset = hora del servidor + mitad del RTT - hora local.
      const offset = tServidor + (t1 - t0) / 2 - t1;
      setOffsetReloj((prev) => (prev === 0 ? offset : prev * 0.3 + offset * 0.7));
      ultimaRespuestaRef.current = Date.now();
      calibrarPendienteRef.current = false;
    } catch {
      // Sin red: el intervalo reintenta con backoff.
    }
  }, []);

  useEffect(() => {
    if (!idSala) return;

    ultimoEventoRef.current = Date.now();
    // IIFE async: la carga inicial setea estado recién después del await
    // (evita el setState sincrónico que marca react/set-state-in-effect).
    (async () => {
      await recargar();
    })();

    // postgres_changes CON filtro server-side por sala: verificado contra la
    // base real el 2026-09-12 (3 salas × 20, 0 eventos ajenos, 0 perdidos).
    // El filtro corta el fan-out entre salas (~3× menos tráfico con 3 salas).
    // `jugadores` usa REPLICA IDENTITY FULL (migración 20) para que los
    // DELETE también matcheen el filtro. Igual se filtra en el cliente por
    // robustez, y el vigilante re-sincroniza si el canal queda mudo.
    const marcarEvento = () => {
      ultimoEventoRef.current = Date.now();
      setDegradado(false);
    };
    // Cambio de estado de verdad: alimenta al vigilante Y pausa el polling.
    const marcarEstado = () => {
      const ahora = Date.now();
      ultimoEventoRef.current = ahora;
      ultimoEstadoRef.current = ahora;
      setDegradado(false);
    };

    // Sin red: aviso inmediato. Al volver, la reconexión del canal y el
    // polling re-sincronizan todo (los puntajes viven en el servidor).
    const alDesconectar = () => setDegradado(true);
    const alReconectar = () => {
      ultimoEventoRef.current = Date.now();
      setDegradado(false);
    };
    window.addEventListener('offline', alDesconectar);
    window.addEventListener('online', alReconectar);

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
        canalRef.current = null;
        // Primero se libera el canal previo (y cualquier huérfano del mismo
        // topic) antes de crear uno nuevo: nunca se pisan dos suscripciones
        // con el mismo topic en la misma conexión.
        await limpiarCanalesDeSala();
        if (desmontado) return;

        const canal = supabase
        .channel(`sala:${idSala}`, {
          config: { presence: { key: tokenRef.current || `host-${idSala}` } },
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'salas', filter: `id=eq.${idSala}` }, (payload) => {
          marcarEstado();
          const fila = payload.new;
          if (!fila || fila.id !== idSala) return;
          if (payload.eventType === 'DELETE') setSala(null);
          else setSala(fila);
        })
        .on('postgres_changes', { event: '*', schema: 'public', table: 'jugadores', filter: `id_sala=eq.${idSala}` }, (payload) => {
          marcarEstado();
          // En DELETE, `payload.old` solo trae la PK (REPLICA IDENTITY DEFAULT):
          // hay que filtrar por id, no por id_sala, o el borrado se pierde.
          if (payload.eventType === 'DELETE') {
            const idBorrado = payload.old?.id;
            if (!idBorrado) return;
            setJugadores((prev) => ordenarJugadores(prev.filter((j) => j.id !== idBorrado)));
            return;
          }
          const fila = payload.new;
          if (!fila || fila.id_sala !== idSala) return;
          setJugadores((prev) => {
            let siguiente = prev;
            if (payload.eventType === 'INSERT') {
              siguiente = prev.some((j) => j.id === fila.id) ? prev : [...prev, fila];
            } else if (payload.eventType === 'UPDATE') {
              siguiente = prev.map((j) => (j.id === fila.id ? fila : j));
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
            marcarEstado();
            if (payload.sala) setSala(payload.sala);
            if (payload.jugadores) setJugadores(ordenarJugadores(payload.jugadores));
            return;
          }
          emisor.emit(payload?.tipo, payload);
        })
        // El reloj ya NO viaja por broadcast: cada cliente lo calibra por REST
        // con `hora_servidor` (ver sincronizarReloj). Cero mensajes Realtime.
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            setListo(true);
            // Canal nuevo: hay que volver a publicar la presencia (el ref
            // quedaba en true del canal anterior y `trackear` retornaba antes).
            trackeadoRef.current = false;
            // Canal nuevo = conexión nueva: recalibrar el reloj.
            ultimaRespuestaRef.current = 0;
            calibrarPendienteRef.current = true;
            ultimoPingRef.current = 0;
            await trackear();
            sincronizarPresencia();
            sincronizarReloj();
          }
        });

        canalRef.current = canal;
      } finally {
        conectando = false;
      }
    };

    conectar();

    // Reloj adaptativo (solo clientes): ráfaga de calibración al arrancar la
    // partida y luego refresco cada 90 s. Fuera de partida o con la pestaña
    // oculta no se envía nada (pingReloj filtra solo).
    const intervaloReloj = setInterval(() => {
      const objetivo = calibrarPendienteRef.current ? PING_MS_CALIBRACION : PING_MS_ESTABLE;
      if (Date.now() - ultimaRespuestaRef.current < objetivo) return;
      if (Date.now() - ultimoPingRef.current < PING_MS_REINTENTO) return;
      sincronizarReloj();
    }, 1500);

    // VIGILANTE: si el canal queda mudo con la partida activa, re-sincroniza
    // el estado y reconstruye el canal (Realtime puede dejar de entregar).
    const vigilante = setInterval(() => {
      const silencio = Date.now() - ultimoEventoRef.current;
      if (silencio > 12000) {
        ultimoEventoRef.current = Date.now();
        setDegradado(true);
        recargar();
        if (esAnfitrionRef.current) return; // el anfitrión reacciona al estado poll
        // Con partida activa reconstruimos el canal para no perder el juego.
        const salaActual = salaRef.current;
        if (salaActual && (salaActual.estado === 'jugando' || salaActual.estado === 'pausado')) {
          conectar();
        }
      }
    }, 5000);

    // POLLING base de respaldo: cada 3 s en partida (barato e infalible),
    // cada 9 s en lobby/finalizado (ahí no pasa nada). Si Realtime acaba de
    // entregar un cambio real, se saltea igual.
    const intervaloPolling = setInterval(() => {
      const enPartida = juegoActivoRef.current || salaRef.current?.estado === 'pausado';
      if (Date.now() - ultimoEstadoRef.current < (enPartida ? 2500 : 9000)) return;
      recargar();
    }, 3000);

    return () => {
      desmontado = true;
      clearInterval(intervaloReloj);
      clearInterval(vigilante);
      clearInterval(intervaloPolling);
      window.removeEventListener('offline', alDesconectar);
      window.removeEventListener('online', alReconectar);
      // Remueve el canal vigente y cualquier reconexión en vuelo del mismo
      // topic (la reconexión es asíncrona y puede crear uno tras el unmount).
      // El próximo `conectar()` espera a que estos canales desaparezcan.
      void limpiarCanalesDeSala();
      canalRef.current = null;
      trackeadoRef.current = false;
      setOnline(new Set());
    };
  }, [idSala, recargar, sincronizarPresencia, trackear, sincronizarReloj, emisor, limpiarCanalesDeSala]);

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
    degradado,
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
