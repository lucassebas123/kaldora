// src/hooks/useAdminAuth.js
//
// Sesión de anfitrión sobre Supabase Auth (email + contraseña).
// Estado: 'cargando' mientras hidrata la sesión persistida, 'fuera' o el
// objeto session de Supabase.

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '../supabaseClient';

export function useAdminAuth() {
  const [sesion, setSesion] = useState(null);
  const [estado, setEstado] = useState('cargando'); // cargando | fuera | dentro
  const [email, setEmail] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setSesion(data.session);
        setEmail(data.session.user?.email || null);
        setEstado('dentro');
      } else {
        setEstado('fuera');
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_evento, nuevaSesion) => {
      if (nuevaSesion) {
        setSesion(nuevaSesion);
        setEmail(nuevaSesion.user?.email || null);
        setEstado('dentro');
      } else {
        setSesion(null);
        setEmail(null);
        setEstado('fuera');
      }
    });

    return () => sub.subscription.unsubscribe();
  }, []);

  const entrar = useCallback(async (emailIngresado, password) => {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: emailIngresado.trim(),
      password,
    });
    if (error) throw error;
    return data;
  }, []);

  const registrar = useCallback(async (emailIngresado, password) => {
    const { data, error } = await supabase.auth.signUp({
      email: emailIngresado.trim(),
      password,
    });
    if (error) throw error;
    return data;
  }, []);

  const salir = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return { sesion, email, estado, entrar, registrar, salir };
}
