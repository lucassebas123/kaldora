import React, { useEffect, useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Loader2, LogIn, ShieldCheck, Lock } from 'lucide-react';
import FondoAnimado from '../../components/FondoAnimado';
import BotonMusica from '../../components/BotonMusica';
import { useAdminAuth } from '../../hooks/useAdminAuth';

export default function AdminLogin() {
  const navigate = useNavigate();
  const location = useLocation();
  // Si venía redirigido de una ruta protegida (p. ej. la vista privada de
  // verificaciones abierta en el celular), vuelve ahí después del login.
  const destino = location.state?.from?.pathname || '/admin';
  const { estado, entrar } = useAdminAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [trabajando, setTrabajando] = useState(false);

  useEffect(() => {
    if (estado === 'dentro') navigate(destino, { replace: true });
  }, [estado, navigate, destino]);

  async function enviar(e) {
    e.preventDefault();
    setError(null);
    if (!email.trim() || !password) {
      setError('Completá email y contraseña.');
      return;
    }
    setTrabajando(true);
    try {
      await entrar(email, password);
      navigate(destino, { replace: true });
    } catch (err) {
      const msg = String(err.message || '');
      if (msg.includes('Invalid login')) {
        setError('Email o contraseña incorrectos.');
      } else if (msg.includes('Email not confirmed')) {
        setError('Tu email aún no está confirmado: revisá tu casilla.');
      } else {
        setError('No pudimos validar tu sesión. Probá de nuevo.');
      }
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <div className="relative min-h-dvh text-white flex items-center justify-center px-5 py-10">
      <FondoAnimado densidad={40} />
      <BotonMusica tema="portal" />

      <form
        onSubmit={enviar}
        className="w-full max-w-sm rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-8 shadow-2xl"
      >
        <div className="text-center mb-8">
          <span className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 text-[#1B1035] shadow-lg shadow-orange-500/30">
            <ShieldCheck size={30} />
          </span>
          <h1 className="text-2xl font-black tracking-tight">Panel del Anfitrión</h1>
          <p className="flex items-center justify-center gap-1.5 text-sm text-[#8B80B3] mt-1">
            <Lock size={12} /> Acceso exclusivo del equipo
          </p>
        </div>

        <label className="block text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-1.5">
          Email
        </label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          className="w-full h-12 rounded-xl bg-white/[0.06] border border-white/15 px-4 text-base outline-none focus:border-amber-400/80 transition mb-4"
        />

        <label className="block text-xs font-bold uppercase tracking-wider text-[#8B80B3] mb-1.5">
          Contraseña
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
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
          {trabajando ? <Loader2 className="animate-spin" size={18} /> : <LogIn size={18} />}
          Entrar
        </button>

        <p className="mt-5 text-center text-[11px] leading-relaxed text-[#6C6193]">
          ¿Necesitás una cuenta nueva para un operador?
          <br />
          Se invita desde el panel (sección <span className="text-[#B8AFD9]">Administradores</span>): le llega un
          mail y define su contraseña al abrirlo. No hay registro público.
        </p>

        <button
          type="button"
          onClick={() => navigate('/')}
          className="mt-6 w-full text-center text-[11px] text-[#6C6193] hover:text-[#B8AFD9] transition"
        >
          ← Volver al portal de juegos
        </button>
      </form>
    </div>
  );
}
