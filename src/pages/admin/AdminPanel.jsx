// src/pages/admin/AdminPanel.jsx
//
// Dashboard del anfitrión: crear salas, ver las propias y entrar a cada una.
// Todo bajo Supabase Auth (la ruta es protegida por el router).

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, Plus, LogOut, Play, Trash2, DoorOpen, Gamepad2, Users2, Crown, UserCog, ExternalLink, MinusCircle, ArrowUpCircle } from 'lucide-react';
import FondoAnimado from '../../components/FondoAnimado';
import BotonMusica from '../../components/BotonMusica';
import { useAdminAuth } from '../../hooks/useAdminAuth';
import { api, consultas } from '../../api/kaldoraApi';
import { JUEGOS } from '../../game/constantes';

const ETIQUETA_ESTADO = {
  en_espera: { texto: 'En espera', clase: 'bg-green-500/15 text-green-300 border-green-400/30' },
  jugando: { texto: 'Jugando', clase: 'bg-sky-500/15 text-sky-300 border-sky-400/30' },
  pausado: { texto: 'Pausada', clase: 'bg-amber-500/15 text-amber-300 border-amber-400/30' },
  finalizado: { texto: 'Finalizada', clase: 'bg-white/10 text-[#B8AFD9] border-white/15' },
};

export default function AdminPanel() {
  const navigate = useNavigate();
  const { email, salir } = useAdminAuth();
  const [salas, setSalas] = useState(null);
  const [admins, setAdmins] = useState(null);
  const [creando, setCreando] = useState(false);
  const [error, setError] = useState(null);

  const cargar = useCallback(async () => {
    // Cargas independientes: si falla una, la otra igual se muestra.
    const [resSalas, resAdmins] = await Promise.allSettled([api.misSalas(), consultas.listarAdmins()]);
    if (resSalas.status === 'fulfilled') setSalas(resSalas.value || []);
    if (resAdmins.status === 'fulfilled') setAdmins(resAdmins.value || []);
    const fallo = [resSalas, resAdmins].find((r) => r.status === 'rejected');
    setError(fallo ? fallo.reason?.message || 'No pudimos cargar el panel.' : null);
  }, []);

  useEffect(() => {
    cargar();
  }, [cargar]);

  async function crearSala() {
    setCreando(true);
    setError(null);
    try {
      const sala = await api.crearSala();
      navigate(`/admin/sala/${sala.id}`);
    } catch (err) {
      setError(err.message);
      setCreando(false);
    }
  }

  async function borrar(e, idSala) {
    e.stopPropagation();
    if (!window.confirm('¿Borrar esta sala y todo su historial?')) return;
    try {
      await api.borrarSala(idSala);
      setSalas((prev) => prev.filter((s) => s.id !== idSala));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="relative min-h-dvh text-white">
      <FondoAnimado densidad={35} />
      <BotonMusica tema="portal" />

      <main className="mx-auto max-w-3xl px-5 py-10">
        <header className="flex items-center justify-between gap-4 mb-10">
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-2">
              <Gamepad2 className="text-fuchsia-400" />
              Kaldora <span className="text-[#8B80B3] font-bold text-lg">· panel</span>
            </h1>
            <p className="text-sm text-[#8B80B3] mt-1 truncate">{email}</p>
          </div>
          <button
            onClick={salir}
            title="Cerrar sesión"
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-xs font-semibold hover:bg-white/10 transition"
          >
            <LogOut size={14} />
            Salir
          </button>
        </header>

        <button
          onClick={crearSala}
          disabled={creando}
          className="w-full h-20 rounded-3xl bg-gradient-to-r from-fuchsia-500 via-purple-500 to-sky-500 font-black text-xl flex items-center justify-center gap-3 shadow-xl shadow-fuchsia-500/25 hover:brightness-110 active:scale-[0.99] transition disabled:opacity-60"
        >
          {creando ? <Loader2 className="animate-spin" size={24} /> : <Plus size={26} />}
          Crear sala nueva
        </button>

        {error && (
          <p className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300 text-center">
            {error}
          </p>
        )}

        <h2 className="mt-10 mb-4 text-sm font-bold uppercase tracking-[0.2em] text-[#8B80B3]">
          Mis salas
        </h2>

        {salas === null ? (
          <div className="flex items-center justify-center py-10 text-[#B8AFD9]">
            <Loader2 className="animate-spin mr-2" /> Cargando salas...
          </div>
        ) : salas.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/15 p-10 text-center text-sm text-[#6C6193]">
            Todavía no creaste ninguna sala.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {salas.map((sala) => {
              const etiqueta = ETIQUETA_ESTADO[sala.estado] || ETIQUETA_ESTADO.en_espera;
              const juego = sala.juego_actual ? JUEGOS[sala.juego_actual] : null;
              return (
                <li key={sala.id}>
                  <button
                    onClick={() => navigate(`/admin/sala/${sala.id}`)}
                    className="w-full flex items-center gap-4 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-4 text-left hover:border-white/25 hover:bg-white/[0.07] transition group"
                  >
                    <span className="text-3xl font-black tabular-nums text-amber-300 tracking-widest w-32">
                      {sala.codigo}
                    </span>
                    <span className="flex flex-col gap-1 min-w-0 flex-1">
                      <span
                        className={`self-start rounded-full border px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider ${etiqueta.clase}`}
                      >
                        {etiqueta.texto}
                      </span>
                      {juego && (
                        <span className="text-xs text-[#8B80B3] truncate">
                          {juego.emoji} {juego.nombre}
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="hidden sm:flex h-9 w-9 items-center justify-center rounded-full bg-white/5 group-hover:bg-white/10 transition">
                        <DoorOpen size={16} className="text-[#B8AFD9]" />
                      </span>
                      {sala.estado === 'finalizado' ? (
                        <span
                          onClick={(e) => borrar(e, sala.id)}
                          title="Borrar sala"
                          className="flex h-9 w-9 items-center justify-center rounded-full bg-white/5 hover:bg-red-500/20 hover:text-red-300 transition cursor-pointer"
                        >
                          <Trash2 size={16} />
                        </span>
                      ) : (
                        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-amber-400/10 group-hover:bg-amber-400/20 transition">
                          <Play size={16} className="text-amber-300" />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {/* Equipo de administradores */}
        <SeccionAdministradores admins={admins} recargar={cargar} />
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Equipo de anfitriones: el dueño gestiona operadores.
// Las cuentas NUEVAS se crean desde el dashboard de Supabase (el registro
// público está deshabilitado) y entran solas al equipo como `operador`.
// ---------------------------------------------------------------------------
function SeccionAdministradores({ admins, recargar }) {
  const { email } = useAdminAuth();
  const yo = admins?.find((a) => a.email === email);
  const soyDueno = yo?.rol === 'dueño';
  const [trabajando, setTrabajando] = useState(false);

  async function ejecutar(fn) {
    if (trabajando) return;
    setTrabajando(true);
    try {
      await fn();
      await recargar();
    } catch (err) {
      alert(err.message);
    } finally {
      setTrabajando(false);
    }
  }

  return (
    <section className="mt-12">
      <div className="flex items-center justify-between mb-4">
        <h2 className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.2em] text-[#8B80B3]">
          <Users2 size={15} />
          Administradores ({admins?.length ?? 0})
        </h2>
        {soyDueno && (
          <a
            href="https://supabase.com/dashboard/project/zmsgtsrigsykwvdhdexc/auth/users"
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] font-bold text-[#B8AFD9] hover:text-white hover:bg-white/10 transition"
          >
            <ExternalLink size={12} />
            Crear cuenta de operador
          </a>
        )}
      </div>

      {admins === null ? (
        <div className="flex items-center gap-2 text-sm text-[#B8AFD9]">
          <Loader2 className="animate-spin" size={15} /> Cargando equipo...
        </div>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {admins.map((admin) => {
              const esYo = admin.email === email;
              return (
                <li
                  key={admin.id}
                  className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3"
                >
                  <span
                    className={`flex h-9 w-9 items-center justify-center rounded-full ${
                      admin.rol === 'dueño' ? 'bg-amber-400/15 text-amber-300' : 'bg-white/5 text-[#B8AFD9]'
                    }`}
                  >
                    {admin.rol === 'dueño' ? <Crown size={16} /> : <UserCog size={16} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold truncate">
                      {admin.email}
                      {esYo && <span className="ml-2 text-[10px] font-black uppercase text-fuchsia-300">vos</span>}
                    </span>
                    <span className="block text-[10px] uppercase tracking-wider text-[#8B80B3]">
                      {admin.rol === 'dueño' ? 'Dueño · puede crear salas y gestionar admins' : 'Operador · crea y controla salas'}
                    </span>
                  </span>

                  {soyDueno && !esYo && (
                    <span className="flex items-center gap-1.5">
                      {admin.rol === 'operador' ? (
                        <button
                          onClick={() => ejecutar(() => api.cambiarRolAdmin(admin.id, 'dueño'))}
                          disabled={trabajando}
                          title="Ascender a dueño"
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-[#B8AFD9] hover:text-amber-300 hover:bg-amber-400/10 transition disabled:opacity-40"
                        >
                          <ArrowUpCircle size={15} />
                        </button>
                      ) : (
                        <button
                          onClick={() => ejecutar(() => api.cambiarRolAdmin(admin.id, 'operador'))}
                          disabled={trabajando}
                          title="Degradar a operador"
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-[#B8AFD9] hover:text-white transition disabled:opacity-40"
                        >
                          <UserCog size={15} />
                        </button>
                      )}
                      <button
                        onClick={() => {
                          if (window.confirm(`¿Quitar el acceso de ${admin.email}?`)) {
                            ejecutar(() => api.quitarAdmin(admin.id));
                          }
                        }}
                        disabled={trabajando}
                        title="Quitar acceso"
                        className="flex h-8 w-8 items-center justify-center rounded-full bg-white/5 text-[#B8AFD9] hover:text-red-300 hover:bg-red-500/10 transition disabled:opacity-40"
                      >
                        <MinusCircle size={15} />
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>

          {soyDueno && (
            <p className="mt-3 text-[11px] leading-relaxed text-[#6C6193]">
              Para SUMAR un operador: tocá "Crear cuenta de operador" → en el dashboard de Supabase,
              <span className="text-[#B8AFD9]"> Authentication → Users → Add user → Create user</span> (con su email y
              contraseña). La cuenta entra sola a esta lista como operador. No hay registro público: nadie puede
              crearse una cuenta desde la web.
            </p>
          )}
        </>
      )}
    </section>
  );
}
