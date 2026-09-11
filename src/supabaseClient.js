import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  // Falla temprano y claro: sin credenciales la app no puede funcionar.
  throw new Error(
    'Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. Copiá .env.example a .env y completá los valores (o configuralos en Vercel).'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
  realtime: {
    params: {
      // Broadcast a alta frecuencia (respuestas, avisos, ping de reloj).
      eventsPerSecond: 30,
    },
  },
});
