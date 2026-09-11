import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error(
    '[supabaseClient] Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY en el archivo .env'
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
