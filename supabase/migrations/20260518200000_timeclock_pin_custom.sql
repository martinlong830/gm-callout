-- Custom PIN assignment + explicit clock-in / clock-out punches from kiosk.

create or replace function public.normalize_pin_input(pin_input text)
returns char(6)
language plpgsql
immutable
as $$
declare
  pin char(6);
begin
  pin := lpad(regexp_replace(coalesce(pin_input, ''), '\D', '', 'g'), 4, '0');
  if length(pin) <> 4 or pin !~ '^[0-9]{4}$' then
    return null;
  end if;
  return pin;
end;
$$;

create or replace function public.set_employee_clock_pin(p_employee_id uuid, pin_input text)
returns char(6)
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(6);
begin
  if not public.is_manager(auth.uid()) then
    raise exception 'Only managers can set clock PINs';
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    raise exception 'Employee not found';
  end if;
  pin := public.normalize_pin_input(pin_input);
  if pin is null then
    raise exception 'PIN must be exactly 4 digits';
  end if;
  if exists (
    select 1 from public.employees e
    where e.clock_pin = pin and e.id <> p_employee_id
  ) then
    raise exception 'That PIN is already assigned to another employee';
  end if;
  update public.employees set clock_pin = pin where id = p_employee_id;
  return pin;
end;
$$;

create or replace function public.timeclock_lookup_pin(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(6);
  emp public.employees%rowtype;
  open_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_timeclock(auth.uid()) and not public.is_manager(auth.uid()) then
    raise exception 'Not allowed';
  end if;

  pin := public.normalize_pin_input(pin_input);
  if pin is null then
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

  return jsonb_build_object(
    'ok', true,
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'is_clocked_in', open_id is not null
  );
end;
$$;

create or replace function public.timeclock_punch_with_action(pin_input text, punch_action text)
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

  pin := public.normalize_pin_input(pin_input);
  if pin is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_pin');
  end if;

  action := lower(trim(coalesce(punch_action, '')));
  if action not in ('in', 'out') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
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

  if action = 'in' then
    if open_id is not null then
      return jsonb_build_object('ok', false, 'error', 'already_in', 'display_name', emp.display_name);
    end if;
    insert into public.time_clock_entries (employee_id, clock_in_at)
    values (emp.id, now_ts);
    return jsonb_build_object(
      'ok', true,
      'action', 'in',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts
    );
  end if;

  if open_id is null then
    return jsonb_build_object('ok', false, 'error', 'not_in', 'display_name', emp.display_name);
  end if;

  update public.time_clock_entries
  set clock_out_at = now_ts
  where id = open_id;

  return jsonb_build_object(
    'ok', true,
    'action', 'out',
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'at', now_ts
  );
end;
$$;

grant execute on function public.set_employee_clock_pin(uuid, text) to authenticated;
grant execute on function public.timeclock_lookup_pin(text) to authenticated;
grant execute on function public.timeclock_punch_with_action(text, text) to authenticated;
