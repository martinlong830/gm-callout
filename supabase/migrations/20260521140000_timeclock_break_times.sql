-- Kiosk break start/end on open punches; surfaces break times in timecards.

alter table public.time_clock_entries
  add column if not exists break_start_at timestamptz;

alter table public.time_clock_entries
  add column if not exists break_end_at timestamptz;

create or replace function public.timeclock_lookup_pin(pin_input text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(4);
  emp public.employees%rowtype;
  open_row public.time_clock_entries%rowtype;
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

  select * into open_row
  from public.time_clock_entries t
  where t.employee_id = emp.id and t.clock_out_at is null
  order by t.clock_in_at desc
  limit 1;

  return jsonb_build_object(
    'ok', true,
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'is_clocked_in', open_row.id is not null,
    'on_break', open_row.id is not null
      and open_row.break_start_at is not null
      and open_row.break_end_at is null
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
  open_row public.time_clock_entries%rowtype;
  action text;
  now_ts timestamptz := now();
  break_mins integer;
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
  if action not in ('in', 'out', 'break_start', 'break_end') then
    return jsonb_build_object('ok', false, 'error', 'invalid_action');
  end if;

  select * into emp
  from public.employees e
  where trim(e.clock_pin) = pin
  limit 1;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'unknown_pin');
  end if;

  select * into open_row
  from public.time_clock_entries t
  where t.employee_id = emp.id and t.clock_out_at is null
  order by t.clock_in_at desc
  limit 1;

  if action = 'in' then
    if open_row.id is not null then
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

  if action = 'out' then
    if open_row.id is null then
      return jsonb_build_object('ok', false, 'error', 'not_in', 'display_name', emp.display_name);
    end if;
  end if;

  if action in ('break_start', 'break_end') then
    if open_row.id is null then
      return jsonb_build_object('ok', false, 'error', 'not_in', 'display_name', emp.display_name);
    end if;
  end if;

  if action = 'break_start' then
    if open_row.break_start_at is not null and open_row.break_end_at is null then
      return jsonb_build_object('ok', false, 'error', 'already_on_break', 'display_name', emp.display_name);
    end if;
    update public.time_clock_entries
    set break_start_at = now_ts, break_end_at = null
    where id = open_row.id;
    return jsonb_build_object(
      'ok', true,
      'action', 'break_start',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts
    );
  end if;

  if action = 'break_end' then
    if open_row.break_start_at is null or open_row.break_end_at is not null then
      return jsonb_build_object('ok', false, 'error', 'not_on_break', 'display_name', emp.display_name);
    end if;
    break_mins := greatest(
      0,
      floor(extract(epoch from (now_ts - open_row.break_start_at)) / 60.0)::integer
    );
    update public.time_clock_entries
    set
      break_end_at = now_ts,
      break_minutes = coalesce(break_minutes, 0) + break_mins
    where id = open_row.id;
    return jsonb_build_object(
      'ok', true,
      'action', 'break_end',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts,
      'break_minutes', break_mins
    );
  end if;

  -- clock out: close any open break segment into break_minutes
  if open_row.break_start_at is not null and open_row.break_end_at is null then
    break_mins := greatest(
      0,
      floor(extract(epoch from (now_ts - open_row.break_start_at)) / 60.0)::integer
    );
    update public.time_clock_entries
    set
      clock_out_at = now_ts,
      break_end_at = now_ts,
      break_minutes = coalesce(break_minutes, 0) + break_mins
    where id = open_row.id;
  else
    update public.time_clock_entries
    set clock_out_at = now_ts
    where id = open_row.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'action', 'out',
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'at', now_ts
  );
end;
$$;
