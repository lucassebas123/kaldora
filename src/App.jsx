import React, { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { useAdminAuth } from './hooks/useAdminAuth';
import { supabase, HASH_INICIAL } from './supabaseClient';
import AvisoActualizacion from './components/AvisoActualizacion';
import { Loader2 } from 'lucide-react';

// Code-splitting por ruta: cada página se descarga recién cuando se entra
// (el portal del jugador no paga el peso del panel de administración).
const Landing = lazy(() => import('./pages/Landing'));
const SalaJugador = lazy(() => import('./pages/SalaJugador'));
const AdminLogin = lazy(() => import('./pages/admin/AdminLogin'));
const AceptarInvitacion = lazy(() => import('./pages/admin/AceptarInvitacion'));
const AdminPanel = lazy(() => import('./pages/admin/AdminPanel'));
const AdminSala = lazy(() => import('./pages/admin/AdminSala'));
const VerificacionesSala = lazy(() => import('./pages/admin/VerificacionesSala'));

// Tipo de auth que traía el link al arrancar (invite / recovery / null).
const TIPO_AUTH = new URLSearchParams(HASH_INICIAL.replace(/^#/, '')).get('type') || '';
const ES_INVITACION = TIPO_AUTH === 'invite' || TIPO_AUTH === 'recovery';

/**
 * El mail de invitación de Supabase aterriza en la Site URL (la raíz del
 * sitio). Apenas el link trae `type=invite`/`recovery`, esta redirección manda
 * al invitado a /admin/invitacion para que defina su contraseña, sin importar
 * en qué ruta haya caído. La sesión la crea supabase-js desde el hash.
 */
function RedirigirInvitacion() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!ES_INVITACION) return undefined;
    let vigente = true;
    const ir = () => {
      if (vigente) navigate('/admin/invitacion', { replace: true });
    };
    supabase.auth
      .getSession()
      .then(({ data }) => {
        if (data.session) ir();
      })
      .catch(() => {});
    const { data: sub } = supabase.auth.onAuthStateChange((evento) => {
      if (evento === 'SIGNED_IN' || evento === 'PASSWORD_RECOVERY') ir();
    });
    // Red de seguridad: si el token venció, /admin/invitacion muestra el error.
    const t = setTimeout(ir, 2500);
    return () => {
      vigente = false;
      clearTimeout(t);
      sub.subscription.unsubscribe();
    };
  }, [navigate]);
  return null;
}

/**
 * Guard de ruta administrativa: solo anfitriones con sesión de Supabase Auth.
 * Mientras hidrata la sesión muestra un spinner (evita el "flash" de login).
 */
function RutaProtegida({ children }) {
  const { estado } = useAdminAuth();
  const location = useLocation();

  if (estado === 'cargando') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0B0616] text-[#B8AFD9]">
        <Loader2 className="animate-spin mr-3" />
        Verificando tu sesión...
      </div>
    );
  }
  if (estado === 'fuera') {
    // Se guarda el destino para volver ahí después del login (por ejemplo, la
    // vista privada de verificaciones abierta desde el celular del anfitrión).
    return <Navigate to="/admin/login" state={{ from: location }} replace />;
  }
  return children;
}

/** Fallback mientras se descarga el chunk de la ruta. */
function CargandoRuta() {
  return (
    <div className="min-h-dvh flex items-center justify-center bg-[#0B0616] text-[#B8AFD9]">
      <Loader2 className="animate-spin mr-3" />
      Cargando...
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <RedirigirInvitacion />
      <AvisoActualizacion />
      <Suspense fallback={<CargandoRuta />}>
        <Routes>
          {/* Público: jugadores */}
          <Route path="/" element={<Landing />} />
          <Route path="/jugar/:codigo" element={<SalaJugador />} />

          {/* Administración (Supabase Auth) */}
          <Route path="/admin/login" element={<AdminLogin />} />
          {/* Destino del mail de invitación de operadores (define contraseña) */}
          <Route path="/admin/invitacion" element={<AceptarInvitacion />} />
          <Route
            path="/admin"
            element={
              <RutaProtegida>
                <AdminPanel />
              </RutaProtegida>
            }
          />
          <Route
            path="/admin/sala/:id"
            element={
              <RutaProtegida>
                <AdminSala />
              </RutaProtegida>
            }
          />
          {/* Vista privada (celular del anfitrión): pendientes con PII. */}
          <Route
            path="/admin/sala/:id/verificaciones"
            element={
              <RutaProtegida>
                <VerificacionesSala />
              </RutaProtegida>
            }
          />

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
