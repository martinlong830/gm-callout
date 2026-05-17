-- Time clock: third account role (timeclock device) + employee 6-digit PIN + punch log.
-- Safe to re-run on projects that already applied an equivalent schema.

-- ---------------------------------------------------------------------------
-- profiles.role: add timeclock (kiosk / shared tablet login)
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

-- Normalize legacy role values from an older schema before re-adding the check.
-- Inspect leftovers: select distinct role from public.profiles order by 1;
update public.profiles
set role = 'timeclock'
where lower(trim(role)) in (
  'timeclock',
  'time_clock',
  'time-clock',
  'kiosk',
  'clock',
  'tablet',
  'device'
);

update public.profiles
set role = 'manager'
where lower(trim(role)) in ('manager', 'admin', 'owner');

update public.profiles
set role = 'employee'
where lower(trim(role)) in ('employee', 'staff', 'worker');

-- Any remaining unknown value becomes employee so the constraint can apply.
update public.profiles
set role = 'employee'
where role is null
   or trim(role) = ''
   or role not in ('manager', 'employee', 'timeclock');

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('manager', 'employee', 'timeclock'));

create or replace function public.is_timeclock(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'timeclock'
  );
$$;

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
  if r not in ('manager', 'employee', 'timeclock') then
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

-- ---------------------------------------------------------------------------
-- employees.clock_pin (6 digits, system-assigned)
-- ---------------------------------------------------------------------------
alter table public.employees
  add column if not exists clock_pin char(6);

create unique index if not exists employees_clock_pin_unique
  on public.employees (clock_pin)
  where clock_pin is not null;

-- ---------------------------------------------------------------------------
-- time_clock_entries (open shift = clock_out_at is null)
-- ---------------------------------------------------------------------------
create table if not exists public.time_clock_entries (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references public.employees (id) on delete cascade,
  clock_in_at timestamptz not null default now(),
  clock_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists time_clock_entries_employee_open_idx
  on public.time_clock_entries (employee_id)
  where clock_out_at is null;

create index if not exists time_clock_entries_clock_in_idx
  on public.time_clock_entries (clock_in_at desc);

drop trigger if exists time_clock_entries_set_updated_at on public.time_clock_entries;
create trigger time_clock_entries_set_updated_at
before update on public.time_clock_entries
for each row
execute procedure public.set_updated_at();

alter table public.time_clock_entries enable row level security;

-- ---------------------------------------------------------------------------
-- PIN helpers + punch RPC (called from timeclock kiosk client)
-- ---------------------------------------------------------------------------
create or replace function public.generate_unique_clock_pin()
returns char(6)
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate char(6);
  attempts int := 0;
begin
  loop
    attempts := attempts + 1;
    if attempts > 200 then
      raise exception 'Could not allocate a unique clock PIN';
    end if;
    candidate := lpad((floor(random() * 1000000))::int::text, 6, '0');
    exit when not exists (
      select 1 from public.employees e where e.clock_pin = candidate
    );
  end loop;
  return candidate;
end;
$$;

create or replace function public.assign_employee_clock_pin(p_employee_id uuid)
returns char(6)
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(6);
begin
  if not public.is_manager(auth.uid()) then
    raise exception 'Only managers can assign clock PINs';
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'Employee not found';
  end if;
  pin := public.generate_unique_clock_pin();
  update public.employees
  set clock_pin = pin
  where id = p_employee_id;
  return pin;
end;
$$;

create or replace function public.timeclock_punch(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(6);
  emp public.employees%rowtype;
  open_id uuid;
  action text;
  now_ts timestamptz := now();
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_timeclock(auth.uid()) and not public.is_manager(auth.uid()) then
    raise exception 'Not allowed';
  end if;

  pin := lpad(regexp_replace(coalesce(pin_input, ''), '\D', '', 'g'), 6, '0');
  if length(pin) <> 6 or pin !~ '^[0-9]{6}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  select * into emp from public.employees e where e.clock_pin = pin limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_pin');
  end if;

  select t.id into open_id
  from public.time_clock_entries t
  where t.employee_id = emp.id and t.clock_out_at is null
  order by t.clock_in_at desc
  limit 1;

  if open_id is not null then
    update public.time_clock_entries
    set clock_out_at = now_ts
    where id = open_id;
    action := 'out';
  else
    insert into public.time_clock_entries (employee_id, clock_in_at)
    values (emp.id, now_ts);
    action := 'in';
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', action,
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'at', now_ts
  );
end;
$$;

grant execute on function public.generate_unique_clock_pin() to authenticated;
grant execute on function public.assign_employee_clock_pin(uuid) to authenticated;
grant execute on function public.timeclock_punch(text) to authenticated;

-- Managers: full punch history; timeclock: insert via RPC only, read recent for UI feedback
drop policy if exists "time_clock_entries_select_managers" on public.time_clock_entries;
create policy "time_clock_entries_select_managers"
on public.time_clock_entries for select
to authenticated
using (public.is_manager(auth.uid()));

drop policy if exists "time_clock_entries_select_timeclock_recent" on public.time_clock_entries;
create policy "time_clock_entries_select_timeclock_recent"
on public.time_clock_entries for select
to authenticated
using (
  public.is_timeclock(auth.uid())
  and clock_in_at > (now() - interval '2 days')
);

-- Bootstrap: create a timeclock auth user in Dashboard, then:
--   update public.profiles set role = 'timeclock', display_name = 'Front iPad' where id = '<uuid>';
