import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Landing from './pages/Landing';
import SalaJugador from './pages/SalaJugador';
import AdminLogin from './pages/admin/AdminLogin';
import AdminPanel from './pages/admin/AdminPanel';
import AdminSala from './pages/admin/AdminSala';
import { useAdminAuth } from './hooks/useAdminAuth';
import AvisoActualizacion from './components/AvisoActualizacion';
import { Loader2 } from 'lucide-react';

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

export default function App() {
  return (
    <BrowserRouter>
      <AvisoActualizacion />
      <Routes>
        {/* Público: jugadores */}
        <Route path="/" element={<Landing />} />
        <Route path="/jugar/:codigo" element={<SalaJugador />} />

        {/* Administración (Supabase Auth) */}
        <Route path="/admin/login" element={<AdminLogin />} />
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
    </BrowserRouter>
  );
}
