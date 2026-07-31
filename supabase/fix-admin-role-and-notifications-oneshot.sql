-- Admin role (company-wide) + in-app notifications + notify helpers.
-- Safe to re-run.

-- ---------------------------------------------------------------------------
-- profiles.role: add admin
-- ---------------------------------------------------------------------------
alter table public.profiles drop constraint if exists profiles_role_check;

update public.profiles
set role = 'admin'
where lower(trim(role)) in ('admin', 'owner', 'superadmin', 'super_admin');

update public.profiles
set role = 'manager'
where lower(trim(role)) in ('manager');

update public.profiles
set role = 'employee'
where lower(trim(role)) in ('employee', 'staff', 'worker');

update public.profiles
set role = 'timeclock'
where lower(trim(role)) in (
  'timeclock', 'time_clock', 'time-clock', 'kiosk', 'clock', 'tablet', 'device'
);

update public.profiles
set role = 'employee'
where role is null
   or trim(role) = ''
   or role not in ('admin', 'manager', 'employee', 'timeclock');

alter table public.profiles
  add constraint profiles_role_check
  check (role in ('admin', 'manager', 'employee', 'timeclock'));

-- Managers + admins share elevated RLS (company-wide for admin is app-layer scoping).
create or replace function public.is_manager(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role in ('manager', 'admin')
  );
$$;

create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.role = 'admin'
  );
$$;

revoke all on function public.is_admin(uuid) from public;
grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.is_admin(uuid) to service_role;

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
  -- Clients must not self-elevate to admin; service-role provisioning sets profiles.role after insert.
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

-- Companies policies that hard-coded role = 'manager' also allow admin.
drop policy if exists "companies_update_managers" on public.companies;
create policy "companies_update_managers"
on public.companies for update
to authenticated
using (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('manager', 'admin')
      and p.company_id = companies.id
  )
)
with check (
  exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.role in ('manager', 'admin')
      and p.company_id = companies.id
  )
);

-- ---------------------------------------------------------------------------
-- Promote known company admins (Martin Long, Ongi Management) when present
-- ---------------------------------------------------------------------------
update public.profiles p
set role = 'admin',
    updated_at = now()
where p.role in ('manager', 'admin')
  and (
    lower(trim(coalesce(p.login_name, ''))) in ('martin long', 'ongi management')
    or lower(trim(coalesce(p.display_name, ''))) in ('martin long', 'ongi management')
    or lower(trim(coalesce(p.login_name_norm, ''))) in ('martin long', 'ongi management')
  );

-- Keep auth metadata in sync when those users exist.
do $$
declare
  r record;
begin
  for r in
    select id, role, display_name, login_name
    from public.profiles
    where role = 'admin'
      and (
        lower(trim(coalesce(login_name, ''))) in ('martin long', 'ongi management')
        or lower(trim(coalesce(display_name, ''))) in ('martin long', 'ongi management')
        or lower(trim(coalesce(login_name_norm, ''))) in ('martin long', 'ongi management')
      )
  loop
    update auth.users u
    set raw_user_meta_data =
      coalesce(u.raw_user_meta_data, '{}'::jsonb)
      || jsonb_build_object(
        'role', 'admin',
        'display_name', coalesce(nullif(trim(r.display_name), ''), r.display_name),
        'login_name', coalesce(nullif(trim(r.login_name), ''), r.display_name)
      )
    where u.id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- In-app notifications
-- ---------------------------------------------------------------------------
create table if not exists public.app_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid references public.companies (id) on delete cascade,
  team_state_id text,
  restaurant_id text,
  type text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists app_notifications_user_created_idx
  on public.app_notifications (user_id, created_at desc);

create index if not exists app_notifications_user_unread_idx
  on public.app_notifications (user_id)
  where read_at is null;

create index if not exists app_notifications_company_idx
  on public.app_notifications (company_id);

alter table public.app_notifications enable row level security;

drop policy if exists "app_notifications_select_own" on public.app_notifications;
create policy "app_notifications_select_own"
on public.app_notifications for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "app_notifications_update_own" on public.app_notifications;
create policy "app_notifications_update_own"
on public.app_notifications for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- Inserts are service-role / security-definer only (no direct client insert).
drop policy if exists "app_notifications_insert_none" on public.app_notifications;
-- service_role bypasses RLS; authenticated cannot insert.

alter table public.app_notifications replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'app_notifications'
  ) then
    alter publication supabase_realtime add table public.app_notifications;
  end if;
end $$;

-- Helper: restaurant scope for an employee roster row.
create or replace function public.employee_store_scope(usual text, meta jsonb)
returns text
language sql
immutable
as $$
  select case
    when usual in ('rp-8', 'rp-9') then usual
    when usual = 'both' then
      case
        when coalesce(meta->>'primaryLocationId', meta->>'primaryRestaurantId', '') in ('rp-8', 'rp-9')
          then coalesce(meta->>'primaryLocationId', meta->>'primaryRestaurantId')
        else null
      end
    else null
  end;
$$;

-- Resolve recipient user ids for manager/admin audience for a store.
create or replace function public.notification_manager_recipient_ids(
  p_company_id uuid,
  p_restaurant_id text default null
)
returns setof uuid
language sql
stable
security definer
set search_path = public
as $$
  -- Admins always (company-wide).
  select p.id
  from public.profiles p
  where p.role = 'admin'
    and (p_company_id is null or p.company_id is null or p.company_id = p_company_id)
  union
  -- Store managers for the restaurant (or all managers when restaurant unknown).
  select p.id
  from public.profiles p
  left join public.employees e on e.auth_user_id = p.id
  where p.role = 'manager'
    and (p_company_id is null or p.company_id is null or p.company_id = p_company_id)
    and (
      p_restaurant_id is null
      or p_restaurant_id = ''
      or public.employee_store_scope(e.usual_restaurant, e.meta) is null
      or public.employee_store_scope(e.usual_restaurant, e.meta) = p_restaurant_id
    );
$$;

create or replace function public.insert_app_notifications(
  p_user_ids uuid[],
  p_company_id uuid,
  p_team_state_id text,
  p_restaurant_id text,
  p_type text,
  p_title text,
  p_body text,
  p_data jsonb default '{}'::jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  n int := 0;
  seen uuid[] := '{}';
begin
  if p_user_ids is null then
    return 0;
  end if;
  foreach uid in array p_user_ids
  loop
    if uid is null or uid = any(seen) then
      continue;
    end if;
    seen := array_append(seen, uid);
    insert into public.app_notifications (
      user_id, company_id, team_state_id, restaurant_id, type, title, body, data
    ) values (
      uid, p_company_id, p_team_state_id, nullif(p_restaurant_id, ''), p_type, p_title, coalesce(p_body, ''), coalesce(p_data, '{}'::jsonb)
    );
    n := n + 1;
  end loop;
  return n;
end;
$$;

revoke all on function public.insert_app_notifications(uuid[], uuid, text, text, text, text, text, jsonb) from public;
grant execute on function public.insert_app_notifications(uuid[], uuid, text, text, text, text, text, jsonb) to service_role;

-- Staff request → in-app notifications
create or replace function public.staff_requests_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  company_id uuid;
  restaurant_id text;
  team_state_id text;
  requester_name text;
  type_label text;
  title text;
  body text;
  recipient_ids uuid[];
  decision text;
begin
  select p.company_id into company_id
  from public.profiles p
  where p.id = coalesce(new.requester_id, old.requester_id);

  select public.employee_store_scope(e.usual_restaurant, e.meta)
  into restaurant_id
  from public.employees e
  where e.auth_user_id = new.requester_id
  limit 1;

  if company_id is not null then
    select c.team_state_id into team_state_id
    from public.companies c
    where c.id = company_id;
  end if;

  requester_name := coalesce(
    nullif(trim(new.payload->>'employeeName'), ''),
    (select display_name from public.profiles where id = new.requester_id),
    'Employee'
  );

  type_label := case new.type
    when 'availability' then 'Availability'
    when 'timeoff' then 'Time off'
    when 'swap' then 'Shift swap'
    when 'callout' then 'Callout'
    else initcap(coalesce(new.type, 'Request'))
  end;

  if tg_op = 'INSERT' and new.status = 'pending' then
    if new.type = 'availability' then
      title := 'Availability submitted';
      body := requester_name || ' submitted availability.';
    else
      title := type_label || ' submitted';
      body := requester_name || ' submitted a ' || lower(type_label) || ' request.';
    end if;

    select coalesce(array_agg(uid), '{}')
    into recipient_ids
    from public.notification_manager_recipient_ids(company_id, restaurant_id) as uid;

    perform public.insert_app_notifications(
      recipient_ids,
      company_id,
      team_state_id,
      restaurant_id,
      case when new.type = 'availability' then 'availability_submitted' else 'request_submitted' end,
      title,
      body,
      jsonb_build_object(
        'staffRequestId', new.id,
        'requestType', new.type,
        'requesterId', new.requester_id,
        'restaurantId', restaurant_id
      )
    );
  elsif tg_op = 'UPDATE'
    and old.status is distinct from new.status
    and new.status in ('approved', 'rejected', 'closed')
    and new.type in ('timeoff', 'swap', 'callout')
  then
    decision := case
      when new.status = 'approved' then 'approved'
      when new.status = 'rejected' then 'declined'
      else 'closed'
    end;
    title := type_label || ' ' || decision;
    body := 'Your ' || lower(type_label) || ' request was ' || decision || '.';

    perform public.insert_app_notifications(
      array[new.requester_id],
      company_id,
      team_state_id,
      restaurant_id,
      'request_decided',
      title,
      body,
      jsonb_build_object(
        'staffRequestId', new.id,
        'requestType', new.type,
        'status', new.status,
        'decision', decision
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists staff_requests_notify on public.staff_requests;
create trigger staff_requests_notify
after insert or update of status on public.staff_requests
for each row
execute procedure public.staff_requests_notify();
