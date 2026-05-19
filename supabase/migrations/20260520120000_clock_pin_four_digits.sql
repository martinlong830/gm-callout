-- Time clock PINs: 4 digits (was 6). Replaces PIN helpers and applies Red Poke roster PINs.

-- Existing 6-char PINs must be cleared before narrowing the column.
update public.employees set clock_pin = null where clock_pin is not null;

alter table public.employees
  alter column clock_pin type char(4) using null;

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

create or replace function public.generate_unique_clock_pin()
returns char(4)
language plpgsql
security definer
set search_path = public
as $$
declare
  candidate char(4);
  attempts int := 0;
begin
  loop
    attempts := attempts + 1;
    if attempts > 500 then
      raise exception 'Could not allocate a unique clock PIN';
    end if;
    candidate := lpad((floor(random() * 10000))::int::text, 4, '0');
    exit when not exists (
      select 1 from public.employees e where e.clock_pin = candidate
    );
  end loop;
  return candidate;
end;
$$;

create or replace function public.assign_employee_clock_pin(p_employee_id uuid)
returns char(4)
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(4);
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

create or replace function public.set_employee_clock_pin(p_employee_id uuid, pin_input text)
returns char(4)
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(4);
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

-- Red Poke roster PINs (display_name match, case-insensitive)
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
