-- Belt-and-suspenders for create-company RLS failures.
-- Root failure mode: server inserts into companies as anon/authenticated
-- (SUPABASE_SERVICE_ROLE_KEY set to the anon key). service_role bypasses RLS;
-- anon does not, and companies previously had SELECT-only policies.
--
-- This migration:
-- 1) Allows pending signup-shaped INSERTs (access_code like pending-%) for anon/authenticated
-- 2) Grants execute on portal_insert_company to anon/authenticated/service_role
-- 3) Keeps service_role table grants + policies
--
-- Auth Admin (createUser) still requires a real service_role API key on the Node server.

alter table public.companies
  add column if not exists access_code_set_at timestamptz;

grant select, insert, update on table public.companies to anon, authenticated;
grant select, insert, update, delete on table public.companies to service_role;

drop policy if exists "companies_select_authenticated" on public.companies;
create policy "companies_select_authenticated"
on public.companies for select
to authenticated
using (true);

drop policy if exists "companies_select_anon" on public.companies;
create policy "companies_select_anon"
on public.companies for select
to anon
using (true);

drop policy if exists "companies_insert_service_role" on public.companies;
create policy "companies_insert_service_role"
on public.companies for insert
to service_role
with check (true);

drop policy if exists "companies_insert_pending_signup" on public.companies;
create policy "companies_insert_pending_signup"
on public.companies for insert
to anon, authenticated
with check (
  access_code is not null
  and access_code like 'pending-%'
  and confirmed_at is null
  and access_code_set_at is null
);

drop policy if exists "companies_update_service_role" on public.companies;
create policy "companies_update_service_role"
on public.companies for update
to service_role
using (true)
with check (true);

drop policy if exists "companies_update_managers" on public.companies;
create policy "companies_update_managers"
on public.companies for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'manager'
      and p.company_id = companies.id
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role = 'manager'
      and p.company_id = companies.id
  )
);

create or replace function public.portal_insert_company(
  p_id uuid,
  p_name text,
  p_access_code text,
  p_team_state_id text,
  p_restaurants_config jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_access_code is null or p_access_code not like 'pending-%' then
    raise exception 'portal_insert_company only accepts pending access codes';
  end if;

  insert into public.companies (
    id,
    name,
    access_code,
    team_state_id,
    restaurants_config,
    confirmed_at,
    access_code_set_at
  )
  values (
    p_id,
    p_name,
    p_access_code,
    coalesce(nullif(p_team_state_id, ''), p_id::text),
    coalesce(p_restaurants_config, '[]'::jsonb),
    null,
    null
  );
  return p_id;
end;
$$;

revoke all on function public.portal_insert_company(uuid, text, text, text, jsonb) from public;
grant execute on function public.portal_insert_company(uuid, text, text, text, jsonb)
  to anon, authenticated, service_role;
