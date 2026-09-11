import React, { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useAdminAuth } from './hooks/useAdminAuth';
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

/**
 * Guard de ruta administrativa: solo anfitriones con sesión de Supabase Auth.
 * Mientras hidrata la sesión muestra un spinner (evita el "flash" de login).
 */
function RutaProtegida({ children }) {
  const { estado } = useAdminAuth();

  if (estado === 'cargando') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#0B0616] text-[#B8AFD9]">
        <Loader2 className="animate-spin mr-3" />
        Verificando tu sesión...
      </div>
    );
  }
  if (estado === 'fuera') {
    return <Navigate to="/admin/login" replace />;
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

          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
