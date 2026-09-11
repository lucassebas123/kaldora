-- =============================================================================
-- KALDORA v2.2 — Gestión del equipo de administradores (solo el DUEÑO)
-- =============================================================================
-- El dueño puede ascender a operador → dueño, degradar y quitar admins.
-- Quitar a alguien le cierra el acceso al panel al instante (los RPCs de
-- anfitrión exigen pertenecer a admins_autorizados).

create or replace function public.es_dueno()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.admins_autorizados
     where id = auth.uid() and rol = 'dueño'
  );
$$;

create or replace function public.cambiar_rol_admin(p_id uuid, p_rol text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.es_dueno() then
    raise exception 'Solo el dueño gestiona administradores' using errcode = '42501';
  end if;
  if p_rol not in ('dueño', 'operador') then
    raise exception 'Rol inválido' using errcode = 'P0001';
  end if;
  update public.admins_autorizados set rol = p_rol where id = p_id;
end;
$$;

create or replace function public.quitar_admin(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.es_dueno() then
    raise exception 'Solo el dueño gestiona administradores' using errcode = '42501';
  end if;
  if p_id = auth.uid() then
    raise exception 'No podés quitarte a vos mismo' using errcode = 'P0001';
  end if;
  delete from public.admins_autorizados where id = p_id;
end;
$$;

grant execute on function public.cambiar_rol_admin(uuid, text) to authenticated;
grant execute on function public.quitar_admin(uuid) to authenticated;
revoke all on function public.es_dueno() from public, anon, authenticated;
