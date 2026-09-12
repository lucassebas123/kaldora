-- =============================================================================
-- LÍMITES DE ACCESO AJUSTABLES — anti fuerza bruta sin bloquear eventos
-- =============================================================================
-- Los umbrales de la v2 estaban fijos en el código de las funciones. En un
-- evento real con IP compartida (NAT del Wi-Fi) el uso legítimo genera fallos:
-- correos nuevos que se tipean (cada uno cuenta como "no existe"), logins
-- equivocados, PINs mal recordados. Con 25 fallos/5 min podía quedar gente
-- afuera sin que hubiera ningún ataque.
--
-- Ahora `verificar_limite` consulta la tabla `limites_acceso` (por acción):
-- cambiar un umbral es un UPDATE, sin recrear funciones. Si no hay fila, usa
-- los argumentos con los que fue llamada.
-- =============================================================================

create table if not exists public.limites_acceso (
  accion  text primary key,
  maximo  int not null check (maximo > 0),
  ventana interval not null
);

alter table public.limites_acceso enable row level security;
revoke all privileges on public.limites_acceso from anon, authenticated;

insert into public.limites_acceso (accion, maximo, ventana) values
  ('pin_fallos',    60, interval '5 minutes'),  -- PINs de sala inexistentes
  ('login_fallos',  40, interval '5 minutes'),  -- logins por correo/celular/PIN
  ('perfil_fallos', 150, interval '5 minutes')  -- correos nuevos tipeados
on conflict (accion) do update
  set maximo = excluded.maximo,
      ventana = excluded.ventana;

create or replace function public.verificar_limite(
  p_accion text,
  p_max int,
  p_ventana interval
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max int := p_max;
  v_ventana interval := p_ventana;
  v_n int;
begin
  select maximo, ventana into v_max, v_ventana
    from public.limites_acceso
   where accion = p_accion;
  if not found then
    -- La tabla siempre tiene filas para las acciones reales; este fallback
    -- deja el comportamiento anterior si aparece una acción nueva.
    v_max := p_max;
    v_ventana := p_ventana;
  end if;

  select count(*) into v_n
    from public.intentos_acceso
   where ip = public.ip_solicitante()
     and accion = p_accion
     and creado_en > clock_timestamp() - v_ventana;

  if v_n >= v_max then
    raise exception 'Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo.'
      using errcode = 'P0001';
  end if;
end;
$$;
