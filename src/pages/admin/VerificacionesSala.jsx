// src/pages/admin/VerificacionesSala.jsx
//
// VISTA PRIVADA de verificación de WhatsApp (/admin/sala/:id/verificaciones).
// Pensada para abrirse en el CELULAR del anfitrión, nunca en la pantalla
// proyectada: acá sí se ven los datos personales (nombre, celular) y el código
// que cada jugador debe mandar por WhatsApp para que el anfitrión confirme.
//
// Flow:
//   1. El jugador toca "Verificar mi WhatsApp" en la sala de espera y envía el
//      código desde SU número (link wa.me prellenado).
//   2. El anfitrión recibe el mensaje en el WhatsApp de la sala, compara el
//      emisor con el celular registrado que aparece acá y toca "Confirmar".
//   3. La confirmación viaja por Realtime: la TV solo actualiza contador y ✅.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft, Loader2, ShieldCheck, MessageCircle, Check, AlertTriangle, Phone,
} from 'lucide-react';
import FondoAnimado from '../../components/FondoAnimado';
import { api } from '../../api/kaldoraApi';

const WHATSAPP_GLOBAL = import.meta.env.VITE_WHATSAPP_ANFITRION || '';

export default function VerificacionesSala() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [datos, setDatos] = useState(null);
  const [error, setError] = useState(null);
  const [guardandoNumero, setGuardandoNumero] = useState(false);
  const [numero, setNumero] = useState(null); // null = todavía sin hidratar
  const [aviso, setAviso] = useState(null);
  const [confirmando, setConfirmando] = useState(null); // idJugador en curso

  const peticionRef = useRef(0);
  const cargar = useCallback(async () => {
    const peticion = ++peticionRef.current;
    try {
      const data = await api.verificacionesPendientes(id);
      if (peticion !== peticionRef.current) return;
      setDatos(data);
      setNumero((prev) => (prev === null ? data?.whatsapp || '' : prev));
      setError(null);
    } catch (err) {
      if (peticion !== peticionRef.current) return;
      setError(err.message || 'No pudimos cargar las verificaciones.');
    }
  }, [id]);

  useEffect(() => {
    // IIFE async: la carga inicial setea estado recién después del await.
    (async () => {
      await cargar();
    })();
    const intervalo = setInterval(cargar, 4000);
    return () => clearInterval(intervalo);
  }, [cargar]);

  async function guardarNumero(e) {
    e.preventDefault();
    if (guardandoNumero) return;
    setGuardandoNumero(true);
    setAviso(null);
    try {
      const res = await api.actualizarContactoWhatsapp(id, numero.trim());
      setNumero(res?.whatsapp || '');
      setAviso('WhatsApp de la sala guardado.');
      await cargar();
    } catch (err) {
      setAviso(err.message || 'No pudimos guardar el número.');
    } finally {
      setGuardandoNumero(false);
    }
  }

  async function confirmar(idJugador) {
    setConfirmando(idJugador);
    try {
      await api.confirmarVerificacion(id, idJugador);
      await cargar();
    } catch (err) {
      setAviso(err.message || 'No pudimos confirmar.');
    } finally {
      setConfirmando(null);
    }
  }

  const pendientes = datos?.pendientes || [];
  const verificados = datos?.verificados ?? 0;
  const total = datos?.total ?? 0;
  const numeroEfectivo = (numero ?? datos?.whatsapp ?? '').trim() || WHATSAPP_GLOBAL;

  return (
    <div className="relative min-h-dvh text-white">
      <FondoAnimado densidad={25} />
      <main className="mx-auto flex min-h-dvh max-w-lg flex-col gap-5 px-5 pt-safe pb-safe">
        <header className="flex items-center gap-3">
          <button
            onClick={() => navigate(`/admin/sala/${id}`)}
            title="Volver a la sala"
            className="flex h-10 w-10 items-center justify-center rounded-full bg-white/5 text-[#B8AFD9] transition hover:bg-white/15"
          >
            <ArrowLeft size={17} />
          </button>
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-lg font-black">
              <ShieldCheck size={19} className="text-emerald-300" />
              Verificaciones
            </h1>
            <p className="text-[11px] text-[#8B80B3]">
              {verificados}/{total} jugadores verificados
            </p>
          </div>
          <span className="ml-auto rounded-full border border-emerald-400/40 bg-emerald-400/10 px-3 py-1 text-[10px] font-black uppercase tracking-wider text-emerald-300">
            {pendientes.length} pendientes
          </span>
        </header>

        {/* Aviso de privacidad: esta vista NO va en la pantalla proyectada. */}
        <p className="flex items-start gap-2 rounded-2xl border border-amber-400/40 bg-amber-400/10 px-4 py-2.5 text-[11px] font-semibold leading-relaxed text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          Vista privada con datos personales: abrila solo en tu celular, no en la pantalla que ve el
          público.
        </p>

        {/* WhatsApp que recibe los códigos de ESTA sala */}
        <form onSubmit={guardarNumero} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
          <p className="flex items-center gap-1.5 text-xs font-black uppercase tracking-wider text-[#B8AFD9]">
            <MessageCircle size={13} className="text-emerald-300" /> WhatsApp de esta sala
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-[#6C6193]">
            Los jugadores te envían el código a este número. Cargalo una vez (podés usar tu WhatsApp
            personal del evento).
          </p>
          <div className="mt-3 flex gap-2">
            <input
              type="tel"
              value={numero ?? ''}
              onChange={(e) => setNumero(e.target.value)}
              placeholder={
                WHATSAPP_GLOBAL ? `Sin configurar (se usa ${WHATSAPP_GLOBAL})` : 'Ej: +54 9 11 5555-1234'
              }
              className="h-12 min-w-0 flex-1 rounded-xl border border-white/15 bg-white/[0.06] px-4 text-base outline-none transition focus:border-emerald-400/80"
            />
            <button
              type="submit"
              disabled={guardandoNumero}
              className="flex h-12 items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-400 to-green-500 px-5 font-extrabold text-[#06281A] transition hover:brightness-110 active:scale-[0.98] disabled:opacity-50"
            >
              {guardandoNumero ? <Loader2 className="animate-spin" size={17} /> : <Check size={17} />}
              Guardar
            </button>
          </div>
          {numeroEfectivo && (
            <p className="mt-2 text-[11px] text-[#8B80B3]">
              Número activo: <span className="font-bold text-white">{numeroEfectivo}</span>
              {!numero?.trim() && WHATSAPP_GLOBAL ? ' (global de respaldo)' : ''}
            </p>
          )}
        </form>

        {aviso && (
          <p className="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2.5 text-xs text-[#B8AFD9]">
            {aviso}
          </p>
        )}

        {error && (
          <p className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-center text-sm text-red-300">
            {error}
          </p>
        )}

        {/* Pendientes */}
        <section className="flex flex-col gap-2.5">
          <h2 className="text-xs font-bold uppercase tracking-[0.2em] text-[#8B80B3]">
            Pendientes de confirmar
          </h2>
          {!datos ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#B8AFD9]">
              <Loader2 className="animate-spin" size={16} /> Cargando...
            </div>
          ) : pendientes.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-emerald-400/30 bg-emerald-400/[0.05] px-5 py-8 text-center">
              <ShieldCheck className="mx-auto mb-2 text-emerald-300" size={26} />
              <p className="text-sm font-bold text-emerald-200">¡Todos verificados!</p>
              <p className="mt-1 text-[11px] text-[#8B80B3]">
                Cuando se sume alguien, va a aparecer acá.
              </p>
            </div>
          ) : (
            pendientes.map((p) => (
              <div
                key={p.idJugador}
                className="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-bold">
                    {p.nickname}
                    {p.nombre && <span className="ml-2 text-xs font-medium text-[#8B80B3]">{p.nombre}</span>}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[#B8AFD9]">
                    <Phone size={11} className="shrink-0" />
                    <span className="truncate">{p.telefono || 'sin celular'}</span>
                  </p>
                  <p className="mt-0.5 text-[11px] text-[#6C6193]">
                    Código a recibir: <span className="font-black tracking-widest text-amber-300">{p.codigo || '—'}</span>
                  </p>
                </div>
                <button
                  onClick={() => confirmar(p.idJugador)}
                  disabled={confirmando === p.idJugador}
                  className="flex h-11 shrink-0 items-center gap-1.5 rounded-xl bg-gradient-to-r from-emerald-400 to-green-500 px-4 text-sm font-black text-[#06281A] transition hover:brightness-110 active:scale-[0.97] disabled:opacity-50"
                >
                  {confirmando === p.idJugador ? (
                    <Loader2 className="animate-spin" size={16} />
                  ) : (
                    <Check size={16} />
                  )}
                  Confirmar
                </button>
              </div>
            ))
          )}
        </section>

        <p className="pb-2 text-center text-[11px] leading-relaxed text-[#6C6193]">
          Compará el número emisor del mensaje de WhatsApp con el celular registrado antes de confirmar.
          La pantalla grande solo muestra el tilde ✅ y el contador.
        </p>
      </main>
    </div>
  );
}
