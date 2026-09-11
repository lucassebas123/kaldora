// src/pages/Landing.jsx
//
// Ruta raíz pública: portal de entrada para JUGADORES.
// PIN gigante + nickname + registro obligatorio (nombre, apellido, celular
// y correo). Los datos viajan a una tabla 100% privada: jamás se muestran
// en pantallas públicas. Cero rastro del panel admin (ese vive en /admin).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, LogIn, ArrowRight, Play, User, Phone, Mail, IdCard } from 'lucide-react';
import FondoAnimado from '../components/FondoAnimado';
import BotonMusica from '../components/BotonMusica';
import { supabase } from '../supabaseClient';
import { api, consultas, leerSesionJugador } from '../api/kaldoraApi';
import { NOMBRES_ICONOS, COLORES_DISPONIBLES } from '../constants/avatares';
import { JUEGOS } from '../game/constantes';

export default function Landing() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const pinDesdeUrl = searchParams.get('sala') || '';

  const [pin, setPin] = useState(pinDesdeUrl);
  const [nickname, setNickname] = useState('');
  const [form, setForm] = useState({ nombre: '', apellido: '', telefono: '', correo: '' });
  const [error, setError] = useState(null);
  const [entrando, setEntrando] = useState(false);
  const [sesionCoincidente, setSesionCoincidente] = useState(null);
  const [perfilReconocido, setPerfilReconocido] = useState(null);

  const pinRef = useRef(null);
  const nickRef = useRef(null);

  useEffect(() => {
    if (pinDesdeUrl) {
      setPin(pinDesdeUrl);
      nickRef.current?.focus();
    } else {
      pinRef.current?.focus();
    }
  }, [pinDesdeUrl]);

  useEffect(() => {
    const sesion = leerSesionJugador();
    if (sesion && (!pin || sesion.codigo === pin)) setSesionCoincidente(sesion);
    else setSesionCoincidente(null);
  }, [pin]);

  // ¿Ya jugaste con este correo? Recuperamos tus datos: solo te identificás.
  useEffect(() => {
    const correo = form.correo.trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo)) {
      setPerfilReconocido(null);
      return undefined;
    }
    const pid = setTimeout(() => {
      api
        .perfilPorCorreo(correo)
        .then((perfil) => {
          if (perfil?.existe) {
            setPerfilReconocido(perfil);
            setForm((f) => ({
              ...f,
              nombre: f.nombre.trim() || perfil.nombre || '',
              apellido: f.apellido.trim() || perfil.apellido || '',
              telefono: f.telefono.trim() || perfil.telefono || '',
            }));
          } else {
            setPerfilReconocido(null);
          }
        })
        .catch(() => {});
    }, 450);
    return () => clearTimeout(pid);
  }, [form.correo]);

  function elegirAvatar(equipos) {
    const tomadas = new Set(equipos.map((j) => `${j.icono}|${j.color}`));
    const libres = [];
    for (const icono of NOMBRES_ICONOS) {
      for (const color of COLORES_DISPONIBLES) {
        if (!tomadas.has(`${icono}|${color}`)) libres.push({ icono, color });
      }
    }
    if (libres.length === 0) {
      return {
        icono: NOMBRES_ICONOS[Math.floor(Math.random() * NOMBRES_ICONOS.length)],
        color: COLORES_DISPONIBLES[Math.floor(Math.random() * COLORES_DISPONIBLES.length)],
      };
    }
    return libres[Math.floor(Math.random() * libres.length)];
  }

  function validar() {
    const pinLimpio = pin.replace(/\D/g, '');
    if (pinLimpio.length !== 6) return 'El PIN de la sala tiene 6 dígitos.';
    if (!nickname.trim()) return 'Escribí tu nickname para entrar.';
    if (nickname.trim().length > 20) return 'El nickname admite hasta 20 caracteres.';
    if (!form.nombre.trim() || !form.apellido.trim()) return 'Ingresá tu nombre y apellido.';
    if (!/^\+?[0-9 ()-]{6,20}$/.test(form.telefono.trim())) return 'Ingresá un número de celular válido.';
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.correo.trim())) return 'Ingresá un correo electrónico válido.';
    return null;
  }

  async function entrar(e) {
    e?.preventDefault?.();
    const problema = validar();
    setError(problema);
    if (problema) return;

    setEntrando(true);
    try {
      const pinLimpio = pin.replace(/\D/g, '');
      const sala = await consultas.salaPorCodigo(pinLimpio);
      if (!sala) {
        setError('No encontramos una sala con ese PIN. Revisalo con el anfitrión.');
        return;
      }
      if (sala.estado !== 'en_espera') {
        setError('Esta partida ya empezó. ¡Atento al próximo PIN!');
        return;
      }

      const { data: equipos } = await supabase
        .from('jugadores')
        .select('id, icono, color')
        .eq('id_sala', sala.id);
      const avatar = elegirAvatar(equipos || []);

      await api.unirseSala(sala.codigo, {
        nickname: nickname.trim(),
        nombre: form.nombre.trim(),
        apellido: form.apellido.trim(),
        telefono: form.telefono.trim(),
        correo: form.correo.trim(),
        ...avatar,
      });
      navigate(`/jugar/${sala.codigo}`, { replace: true });
    } catch (err) {
      setError(err.message || 'No pudimos conectarnos. Probá otra vez.');
    } finally {
      setEntrando(false);
    }
  }

  async function reanudar() {
    if (!sesionCoincidente) return;
    navigate(`/jugar/${sesionCoincidente.codigo}`, { replace: true });
  }

  const tarjetas = useMemo(() => Object.values(JUEGOS), []);

  return (
    <div className="relative min-h-dvh text-white flex flex-col">
      <FondoAnimado />
      <BotonMusica tema="portal" />

      <main className="flex-1 flex flex-col items-center px-5 py-10 sm:py-14">
        {/* Marca */}
        <header className="text-center mb-10 sm:mb-12">
          <h1 className="text-5xl sm:text-7xl font-black tracking-tight font-display">
            <span className="bg-gradient-to-r from-amber-300 via-fuchsia-400 to-sky-400 bg-clip-text text-transparent animate-degradado">
              KALDORA
            </span>
          </h1>
          <p className="mt-3 text-base sm:text-lg text-[#B8AFD9] font-medium">
            ¡Bienvenidos, jugadores!
          </p>
        </header>

        {/* Tarjeta de ingreso + registro */}
        <form
          onSubmit={entrar}
          className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.04] backdrop-blur-xl p-6 sm:p-8 shadow-2xl shadow-fuchsia-500/10"
        >
          <label className="block text-center text-xs font-bold uppercase tracking-[0.25em] text-[#8B80B3] mb-3">
            Game PIN
          </label>
          <input
            ref={pinRef}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="off"
            aria-label="PIN de la sala"
            placeholder="••••••"
            className="w-full h-20 rounded-2xl bg-white/[0.06] border border-white/15 px-4 text-center text-5xl sm:text-6xl font-black tracking-[0.35em] text-white outline-none focus:border-amber-400/80 focus:bg-amber-400/5 focus:shadow-[0_0_40px_-10px_rgba(251,191,36,0.5)] transition placeholder:text-white/20"
          />

          <label className="block text-center text-xs font-bold uppercase tracking-[0.25em] text-[#8B80B3] mt-6 mb-3">
            Tu nickname
          </label>
          <input
            ref={nickRef}
            value={nickname}
            onChange={(e) => setNickname(e.target.value.slice(0, 20))}
            placeholder="Ej: Alex"
            autoComplete="off"
            className="w-full h-14 rounded-2xl bg-white/[0.06] border border-white/15 px-5 text-lg font-semibold text-center outline-none focus:border-fuchsia-400/80 focus:bg-fuchsia-400/5 transition placeholder:text-white/25 placeholder:font-normal placeholder:text-base"
          />

          {/* Registro obligatorio (privado) */}
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/20 p-4">
            <p className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-[0.2em] text-[#8B80B3] mb-3">
              <IdCard size={13} className="text-sky-300" />
              ¡Regístrate para empezar a jugar y disfrutar!
            </p>
            <div className="grid grid-cols-2 gap-2.5">
              <CampoConIcono
                icono={<User size={14} />}
                placeholder="Nombre"
                value={form.nombre}
                onChange={(v) => setForm((f) => ({ ...f, nombre: v }))}
              />
              <CampoConIcono
                icono={<User size={14} />}
                placeholder="Apellido"
                value={form.apellido}
                onChange={(v) => setForm((f) => ({ ...f, apellido: v }))}
              />
              <CampoConIcono
                icono={<Phone size={14} />}
                placeholder="Celular"
                tipo="tel"
                value={form.telefono}
                onChange={(v) => setForm((f) => ({ ...f, telefono: v }))}
              />
              <CampoConIcono
                icono={<Mail size={14} />}
                placeholder="Correo"
                tipo="email"
                value={form.correo}
                onChange={(v) => setForm((f) => ({ ...f, correo: v }))}
              />
            </div>
            {perfilReconocido && (
              <p className="mt-2.5 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-[11px] font-bold text-emerald-200">
                ¡Bienvenido de nuevo, {perfilReconocido.nombre}! Ya te conocemos — confirmá tus datos y a
                jugar.
              </p>
            )}
            {!perfilReconocido && (
              <p className="mt-2.5 text-[10px] leading-relaxed text-[#6C6193]">
                Tus datos son privados: solo los ve el anfitrión para premios y contacto. Nunca aparecen en
                pantalla.
              </p>
            )}
          </div>

          {error && (
            <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300 text-center">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={entrando}
            className="mt-6 w-full flex items-center justify-center gap-2 h-14 rounded-2xl bg-gradient-to-r from-amber-400 to-orange-500 text-[#1B1035] text-lg font-extrabold shadow-lg shadow-orange-500/25 hover:brightness-110 active:scale-[0.98] transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {entrando ? <Loader2 className="animate-spin" size={22} /> : <LogIn size={22} />}
            Entrar a la sala
          </button>

          {sesionCoincidente && !entrando && (
            <button
              type="button"
              onClick={reanudar}
              className="mt-3 w-full flex items-center justify-center gap-2 h-12 rounded-2xl border border-sky-400/40 bg-sky-400/10 text-sky-200 text-sm font-bold hover:bg-sky-400/20 transition"
            >
              <ArrowRight size={16} />
              Ya estabas en la sala {sesionCoincidente.codigo} — volver
            </button>
          )}
        </form>

        {/* Juegos */}
        <section className="mt-14 w-full max-w-4xl">
          <h2 className="text-center text-sm font-bold uppercase tracking-[0.3em] text-[#8B80B3] mb-6">
            Cuatro juegos. Un mismo hub.
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {tarjetas.map((juego) => (
              <article
                key={juego.id}
                className="group relative overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] p-5 hover:border-white/25 transition"
              >
                <div
                  className={`absolute inset-0 bg-gradient-to-br ${juego.color} opacity-[0.07] group-hover:opacity-[0.16] transition`}
                />
                <div className="relative flex items-start gap-3">
                  <span className="text-3xl">{juego.emoji}</span>
                  <div>
                    <h3 className={`font-extrabold text-lg ${juego.acento}`}>{juego.nombre}</h3>
                    <p className="text-sm text-[#B8AFD9] mt-1 leading-snug">{juego.descripcion}</p>
                  </div>
                </div>
              </article>
            ))}
          </div>

          <p className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-[#6C6193]">
            <Play size={13} />
            El anfitrión proyecta el juego; vos jugás desde el celular.
          </p>
        </section>
      </main>
    </div>
  );
}

function CampoConIcono({ icono, placeholder, value, onChange, tipo = 'text' }) {
  return (
    <label className="relative block">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#6C6193]">{icono}</span>
      <input
        type={tipo}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        className="w-full h-11 rounded-xl bg-white/[0.05] border border-white/10 pl-9 pr-3 text-sm font-medium outline-none focus:border-sky-400/70 transition placeholder:text-[#6C6193] placeholder:font-normal"
      />
    </label>
  );
}
