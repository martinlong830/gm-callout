-- Single-store Red Poke Scheduler — initial schema (Supabase SQL editor or CLI).
-- Run once per project. If you see "relation profiles already exists", skip this file:
-- your project already has this schema; run only later migrations (e.g. employees).

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Profiles (one row per auth user; created by trigger on signup)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'employee' check (role in ('manager', 'employee')),
  display_name text not null,
  phone text,
  staff_type text check (
    staff_type is null
    or staff_type in ('Kitchen', 'Bartender', 'Server')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
before update on public.profiles
for each row
execute procedure public.set_updated_at();

-- Sign-up: role / display_name / phone / staff_type may be passed in raw_user_meta_data.
-- For production manager provisioning, prefer an Edge Function or invite-only flow
-- so clients cannot self-elevate via metadata.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  st text;
begin
  r := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'employee');
  if r not in ('manager', 'employee') then
    r := 'employee';
  end if;

  st := nullif(new.raw_user_meta_data->>'staff_type', '');
  if st is not null and st not in ('Kitchen', 'Bartender', 'Server') then
    st := null;
  end if;

  insert into public.profiles (id, role, display_name, phone, staff_type)
  values (
    new.id,
    r,
    coalesce(
      nullif(trim(new.raw_user_meta_data->>'display_name'), ''),
      split_part(coalesce(new.email, ''), '@', 1),
      'User'
    ),
    nullif(trim(new.raw_user_meta_data->>'phone'), ''),
    st
  );
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row
execute procedure public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Staff requests (availability, time off, swaps, callouts — payload is JSONB)
-- ---------------------------------------------------------------------------
create table public.staff_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references auth.users (id) on delete cascade,
  type text not null check (type in ('availability', 'timeoff', 'swap', 'callout')),
  status text not null default 'pending' check (
    status in ('pending', 'approved', 'rejected', 'closed')
  ),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger staff_requests_set_updated_at
before update on public.staff_requests
for each row
execute procedure public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS (single store: all authenticated users are one team)
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.staff_requests enable row level security;

create or replace function public.is_manager(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'manager'
  );
$$;

-- Profiles: team roster visible to signed-in users; update own or manager updates any
create policy "profiles_select_team"
on public.profiles
for select
to authenticated
using (true);

create policy "profiles_update_self"
on public.profiles
for update
to authenticated
using (auth.uid() = id)
with check (auth.uid() = id);

create policy "profiles_update_manager"
on public.profiles
for update
to authenticated
using (public.is_manager(auth.uid()))
with check (true);

-- Requests: see own rows or all if manager; insert own; managers change status
create policy "staff_requests_select_team"
on public.staff_requests
for select
to authenticated
using (
  requester_id = auth.uid()
  or public.is_manager(auth.uid())
);

create policy "staff_requests_insert_self"
on public.staff_requests
for insert
to authenticated
with check (requester_id = auth.uid());

create policy "staff_requests_update_manager"
on public.staff_requests
for update
to authenticated
using (public.is_manager(auth.uid()))
with check (true);

-- Optional: first manager bootstrap — run once in SQL after creating your user:
--   update public.profiles set role = 'manager' where id = '<your-auth-user-uuid>';
