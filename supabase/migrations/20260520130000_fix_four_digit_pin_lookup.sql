-- Fix 4-digit PIN lookup: legacy timeclock_punch still padded to 6 digits (1004 → 001004).
-- Match employees with trim() on char(n) columns.

create or replace function public.normalize_pin_input(pin_input text)
returns char(4)
language plpgsql
immutable
as $$
declare
  pin char(4);
begin
  pin := lpad(regexp_replace(coalesce(pin_input, ''), '\D', '', 'g'), 4, '0');
  if length(pin) <> 4 or pin !~ '^[0-9]{4}$' then
    return null;
  end if;
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
  pin char(4);
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

  select * into emp
  from public.employees e
  where trim(e.clock_pin) = pin
  limit 1;
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

create or replace function public.timeclock_lookup_pin(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(4);
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

  select * into emp
  from public.employees e
  where trim(e.clock_pin) = pin
  limit 1;
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
  pin char(4);
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

  select * into emp
  from public.employees e
  where trim(e.clock_pin) = pin
  limit 1;
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

-- Re-apply roster PINs (idempotent; does not clear other employees).
update public.employees set clock_pin = '0317' where upper(trim(display_name)) = 'MARK ONG';
update public.employees set clock_pin = '1023' where upper(trim(display_name)) = 'CHARLES JAKOB ZACANI';
update public.employees set clock_pin = '1225' where upper(trim(display_name)) = 'EUGENE VILLARRUZ';
update public.employees set clock_pin = '1106' where upper(trim(display_name)) = 'MAEVE WILLIAMS';
update public.employees set clock_pin = '1004' where upper(trim(display_name)) = 'JON ARELLANO';
update public.employees set clock_pin = '0606' where upper(trim(display_name)) = 'BALTAZAR LUCAS';
update public.employees set clock_pin = '0802' where upper(trim(display_name)) = 'ENRIQUE CUMES';
update public.employees set clock_pin = '0727' where upper(trim(display_name)) = 'ARMANDO CUMES';
update public.employees set clock_pin = '1119' where upper(trim(display_name)) in ('JOEL HERNANDES', 'JOEL HERNANDEZ');
update public.employees set clock_pin = '0916' where upper(trim(display_name)) = 'ZEFERINO FLORES';
update public.employees set clock_pin = '0627' where upper(trim(display_name)) = 'IRINEO PINEDA';
update public.employees set clock_pin = '0113' where upper(trim(display_name)) = 'JUAN SALVATIERRA';
update public.employees set clock_pin = '0705' where upper(trim(display_name)) = 'NATALIO DE LA CRUZ';
update public.employees set clock_pin = '1213' where upper(trim(display_name)) in ('ABEL LUJON', 'ABEL LUJAN');
