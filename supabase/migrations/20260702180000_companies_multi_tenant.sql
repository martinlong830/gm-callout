-- Multi-company onboarding (Shiflow): companies table + profile/team_state scoping.
-- Backfills existing Red Poke data under access code "redpoke".

create table if not exists public.companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  access_code text not null,
  team_state_id text not null default 'main',
  restaurants_config jsonb not null default '[]'::jsonb,
  owner_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  confirmed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index if not exists companies_access_code_lower_unique
  on public.companies (lower(access_code));

drop trigger if exists companies_set_updated_at on public.companies;
create trigger companies_set_updated_at
before update on public.companies
for each row
execute procedure public.set_updated_at();

alter table public.companies enable row level security;

drop policy if exists "companies_select_authenticated" on public.companies;
create policy "companies_select_authenticated"
on public.companies for select
to authenticated
using (true);

-- Red Poke (existing single-tenant data)
insert into public.companies (
  id,
  name,
  access_code,
  team_state_id,
  confirmed_at,
  restaurants_config
)
values (
  'a0000000-0000-4000-8000-000000000001',
  'Red Poke',
  'redpoke',
  'main',
  now(),
  '[
    {"id":"rp-9","shortLabel":"9th Ave","name":"Red Poke 598 9th Ave"},
    {"id":"rp-8","shortLabel":"8th Ave","name":"Red Poke 885 8th Ave"}
  ]'::jsonb
)
on conflict (id) do nothing;

alter table public.profiles
  add column if not exists company_id uuid references public.companies (id) on delete set null;

update public.profiles
set company_id = 'a0000000-0000-4000-8000-000000000001'
where company_id is null;

alter table public.team_state
  add column if not exists company_id uuid references public.companies (id) on delete set null;

update public.team_state
set company_id = 'a0000000-0000-4000-8000-000000000001'
where id = 'main' and company_id is null;

-- Per-company login names (scoped uniqueness when company_id is set).
drop index if exists profiles_login_name_norm_unique;
create unique index if not exists profiles_login_name_norm_global_unique
  on public.profiles (login_name_norm)
  where login_name_norm is not null and company_id is null;

create unique index if not exists profiles_company_login_name_norm_unique
  on public.profiles (company_id, login_name_norm)
  where login_name_norm is not null and company_id is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  st text;
  ln text;
  lnn text;
  cid uuid;
begin
  r := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'employee');
  if r not in ('manager', 'employee', 'timeclock') then
    r := 'employee';
  end if;

  st := nullif(new.raw_user_meta_data->>'staff_type', '');
  if st is not null and st not in ('Kitchen', 'Bartender', 'Server') then
    st := null;
  end if;

  ln := nullif(trim(new.raw_user_meta_data->>'login_name'), '');
  if ln is null then
    ln := nullif(trim(new.raw_user_meta_data->>'display_name'), '');
  end if;
  if ln is null then
    ln := split_part(coalesce(new.email, ''), '@', 1);
  end if;
  if ln is null or ln = '' then
    ln := 'User';
  end if;

  lnn := nullif(trim(new.raw_user_meta_data->>'login_name_norm'), '');
  if lnn is null then
    lnn := lower(trim(ln));
  end if;

  cid := null;
  begin
    cid := nullif(new.raw_user_meta_data->>'company_id', '')::uuid;
  exception when others then
    cid := null;
  end;

  insert into public.profiles (
    id,
    role,
    display_name,
    phone,
    staff_type,
    login_name,
    login_name_norm,
    internal_auth_email,
    company_id
  )
  values (
    new.id,
    r,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), ln),
    nullif(trim(new.raw_user_meta_data->>'phone'), ''),
    st,
    ln,
    lnn,
    nullif(trim(coalesce(new.email, '')), ''),
    cid
  );
  return new;
end;
$$;
