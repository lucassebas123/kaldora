// src/pages/admin/AceptarInvitacion.jsx
//
// Ruta pública /admin/invitacion: destino del link que Supabase manda por
// correo cuando el dueño invita a un operador (Authentication → Users → Invite).
//
// Flujo:
//   1. `supabase-js` detecta el token del hash (#access_token=...&type=invite)
//      y crea la sesión (detectSessionInUrl viene activado por default).
//   2. El hook useAdminAuth hidrata esa sesión ('cargando' → 'dentro').
//   3. Acá el invitado define su contraseña (updateUser) y entra al panel.
//
// Si el link venció o ya se usó, GoTrue redirige con `error_description` en el
// hash y no hay sesión: se muestra el estado de error con salida al login.
// El alta en `admins_autorizados` es automática: trigger `trg_admin_automatico`.

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, KeyRound, ShieldCheck, CheckCircle2, AlertTriangle, ArrowLeft, LogIn,
} from 'lucide-react';
import FondoAnimado from '../../components/FondoAnimado';
import BotonMusica from '../../components/BotonMusica';
import { useAdminAuth } from '../../hooks/useAdminAuth';

// Se leen ANTES de que el cliente los consuma (solo para copy/estado visual;
// la lógica real se apoya en la sesión, no en el hash).
const HASH = typeof window !== 'undefined'
  ? new URLSearchParams(window.location.hash.replace(/^#/, ''))
  : new URLSearchParams();
const TIPO = HASH.get('type') || '';
const ERROR_LINK = HASH.get('error_description') || HASH.get('error') || null;

const MINIMO = 8;

export default function AceptarInvitacion() {
  const navigate = useNavigate();
  const { estado, email, actualizarPassword } = useAdminAuth();
  const [password, setPassword] = useState('');
  const [repetir, setRepetir] = useState('');
  const [error, setError] = useState(
    ERROR_LINK ? 'El link ya venció o fue usado. Pedile una invitación nueva al dueño del panel.' : null
  );
  const [trabajando, setTrabajando] = useState(false);
  const [listo, setListo] = useState(false);

  const linkRoto = Boolean(ERROR_LINK) || estado === 'fuera';
  const invitacion = TIPO === 'invite' || TIPO === 'signup';

  async function guardar(e) {
    e.preventDefault();
    setError(null);
    if (password.length < MINIMO) {
      setError(`La contraseña necesita al menos ${MINIMO} caracteres.`);
      return;
    }
    if (password !== repetir) {
      setError('Las dos contraseñas no coinciden.');
      return;
    }
    setTrabajando(true);
    try {
      await actualizarPassword(password);
      setListo(true);
      setTimeout(() => navigate('/admin', { replace: true }), 1200);
    } catch (err) {
      const msg = String(err.message || '');
      if (/different from the old password/i.test(msg)) {
        setError('Elegí una contraseña distinta a la que ya tenías.');
      } else if (/weak|at least|minimum|caracteres/i.test(msg)) {
        setError('Contraseña demasiado débil: probá con una más larga.');
      } else {
        setError('No pudimos guardar la contraseña. Pedí una invitación nueva.');
      }
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="relative min-h-dvh text-white flex items-center justify-center px-5 py-10">
      <FondoAnimado densidad={40} />
      <BotonMusica tema="portal" />

      <div className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-8 shadow-2xl">
        <div className="text-center mb-8">
          <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-[#1B1035] shadow-lg shadow-orange-500/30">
            {listo ? <CheckCircle2 size={30} /> : <ShieldCheck size={30} />}
          </span>
          <h1 className="text-2xl font-black tracking-tight">
            {listo ? '¡Listo!' : invitacion ? '¡Bienvenido al equipo!' : 'Definí tu contraseña'}
          </h1>
          <p className="text-sm text-[#8B80B3] mt-1">
            {listo
              ? 'Entrando al panel...'
              : invitacion
                ? 'Tu invitación fue verificada: creá tu contraseña para entrar.'
                : 'Elegí una contraseña para tu cuenta de anfitrión.'}
          </p>
        </div>

        {listo && (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-bold text-emerald-200">
            <CheckCircle2 size={16} /> Contraseña guardada. Redirigiendo...
          </div>
        )}

        {!listo && estado === 'cargando' && (
          <div className="flex items-center justify-center gap-2 py-4 text-[#B8AFD9]">
            <Loader2 className="animate-spin" size={18} /> Validando tu invitación...
          </div>
        )}

        {!listo && estado !== 'cargando' && linkRoto && (
          <div className="flex flex-col gap-4">
            <p className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <span>{error || 'No encontramos una invitación válida en este link.'}</span>
            </p>
            <button
              type="button"
              onClick={() => navigate('/admin/login', { replace: true })}
              className="w-full h-12 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1B1035] font-extrabold flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.98] transition"
            >
              <LogIn size={18} /> Ir al login
            </button>
            <button
              type="button"
              onClick={() => navigate('/', { replace: true })}
              className="w-full text-center text-[11px] text-[#6C6193] hover:text-[#B8AFD9] transition"
            >
              ← Volver al portal de juegos
            </button>
          </div>
        )}

        {!listo && estado === 'dentro' && !linkRoto && (
          <form onSubmit={guardar}>
            <label className="block text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-1.5">
              Tu cuenta
            </label>
            <input
              type="email"
              value={email || ''}
              readOnly
              className="w-full h-12 rounded-xl bg-white/[0.03] border border-white/10 px-4 text-base text-[#B8AFD9] outline-none mb-4"
            />

            <label className="block text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-1.5">
              Contraseña nueva ({MINIMO}+ caracteres)
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              className="w-full h-12 rounded-xl bg-white/[0.06] border border-white/15 px-4 text-base outline-none focus:border-amber-400/80 transition mb-4"
            />

            <label className="block text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-1.5">
              Repetir contraseña
            </label>
            <input
              type="password"
              value={repetir}
              onChange={(e) => setRepetir(e.target.value)}
              autoComplete="new-password"
              className="w-full h-12 rounded-xl bg-white/[0.06] border border-white/15 px-4 text-base outline-none focus:border-amber-400/80 transition"
            />

            {error && (
              <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300 text-center">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={trabajando}
              className="mt-6 w-full h-12 rounded-xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1B1035] font-extrabold flex items-center justify-center gap-2 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50"
            >
              {trabajando ? <Loader2 className="animate-spin" size={18} /> : <KeyRound size={18} />}
              Guardar y entrar
            </button>

            <button
              type="button"
              onClick={() => navigate('/admin', { replace: true })}
              className="mt-5 w-full flex items-center justify-center gap-1.5 text-center text-[11px] text-[#6C6193] hover:text-[#B8AFD9] transition"
            >
              <ArrowLeft size={12} /> Ya tengo contraseña: ir al panel
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
