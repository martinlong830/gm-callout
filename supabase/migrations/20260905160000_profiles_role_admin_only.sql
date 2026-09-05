-- Block client-side profiles.role changes (privilege escalation).
-- Admins change manager ↔ employee via portal service-role API only.

create or replace function public.profiles_block_client_role_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'UPDATE' and new.role is distinct from old.role then
    if coalesce(auth.jwt() ->> 'role', '') is distinct from 'service_role' then
      raise exception 'Changing account role is not allowed from the client';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_block_client_role_mutation on public.profiles;
create trigger profiles_block_client_role_mutation
before update on public.profiles
for each row
execute procedure public.profiles_block_client_role_mutation();

comment on function public.profiles_block_client_role_mutation() is
  'Rejects authenticated client updates that change profiles.role; service_role (portal admin API) may change roles.';
