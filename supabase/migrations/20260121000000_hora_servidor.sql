-- =============================================================================
-- HORA DEL SERVIDOR — calibración de reloj por REST (sin gastar Realtime)
-- =============================================================================
-- El ping/pong por broadcast (`hora_req`/`hora_res`) costaba dos mensajes por
-- jugador entregados a TODA la sala: medido con 3 salas × 20 daba ~870 msg/s
-- solo de reloj (el plan Free permite 100). Ahora cada cliente pide la hora
-- una vez al empezar la partida (y la refresca cada 5 minutos) con este RPC:
-- cero mensajes de Realtime y una precisión igual (mitad del RTT).
--
-- offset = hora_servidor + rtt/2 - hora_local
-- =============================================================================

create or replace function public.hora_servidor()
returns timestamptz
language sql
volatile
security definer
set search_path = public
as $$
  select clock_timestamp();
$$;

grant execute on function public.hora_servidor() to anon, authenticated;
