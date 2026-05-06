-- Roster rows (shared web + mobile). Auth users can own a row; managers manage all.
-- Safe to re-run: skips objects that already exist (useful after partial runs or SQL Editor retries).

create table if not exists public.employees (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid references auth.users (id) on delete set null,
  first_name text not null,
  last_name text not null,
  display_name text not null,
  phone text not null default '',
  staff_type text not null check (staff_type in ('Kitchen', 'Bartender', 'Server')),
  usual_restaurant text not null default 'rp-9',
  weekly_grid jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists employees_display_name_lower on public.employees (lower(display_name));

drop trigger if exists employees_set_updated_at on public.employees;
create trigger employees_set_updated_at
before update on public.employees
for each row
execute procedure public.set_updated_at();

alter table public.employees enable row level security;

drop policy if exists "employees_select_team" on public.employees;
create policy "employees_select_team"
on public.employees for select
to authenticated
using (true);

drop policy if exists "employees_insert_team" on public.employees;
-- Managers add roster; signed-in user may insert their own row (self-serve signup).
create policy "employees_insert_team"
on public.employees for insert
to authenticated
with check (
  public.is_manager(auth.uid())
  or (auth_user_id is not null and auth_user_id = auth.uid())
);

drop policy if exists "employees_update_team" on public.employees;
create policy "employees_update_team"
on public.employees for update
to authenticated
using (
  public.is_manager(auth.uid())
  or auth_user_id = auth.uid()
)
with check (
  public.is_manager(auth.uid())
  or auth_user_id = auth.uid()
);

drop policy if exists "employees_delete_managers" on public.employees;
create policy "employees_delete_managers"
on public.employees for delete
to authenticated
using (public.is_manager(auth.uid()));
