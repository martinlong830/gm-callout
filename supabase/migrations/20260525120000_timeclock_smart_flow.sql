-- Smart kiosk flow: auto clock-out setting, multi-break segments, updated RPCs.

alter table public.team_state
  add column if not exists timeclock_settings jsonb not null default '{"auto_clock_out_time":"00:00"}'::jsonb;

alter table public.time_clock_entries
  add column if not exists break_segments jsonb not null default '[]'::jsonb;

update public.team_state
set timeclock_settings = coalesce(timeclock_settings, '{"auto_clock_out_time":"00:00"}'::jsonb)
where id = 'main';

create or replace function public.timeclock_settings_effective()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select ts.timeclock_settings from public.team_state ts where ts.id = 'main'),
    '{"auto_clock_out_time":"00:00"}'::jsonb
  );
$$;

create or replace function public.parse_time_hhmm(t text)
returns time
language plpgsql
immutable
as $$
declare
  parts text[];
  h integer;
  m integer;
begin
  parts := string_to_array(trim(coalesce(t, '00:00')), ':');
  h := coalesce(nullif(parts[1], ''), '0')::integer;
  m := coalesce(nullif(parts[2], ''), '0')::integer;
  if h < 0 or h > 23 or m < 0 or m > 59 then
    return time '00:00';
  end if;
  return make_time(h, m, 0);
end;
$$;

create or replace function public.timeclock_auto_clockout_boundary(clock_in_at timestamptz, as_of timestamptz)
returns timestamptz
language plpgsql
stable
as $$
declare
  settings jsonb;
  auto_t time;
  tz text := 'America/Los_Angeles';
  local_as_of timestamp;
  local_in timestamp;
  d date;
  candidate timestamptz;
  best timestamptz := null;
begin
  settings := public.timeclock_settings_effective();
  auto_t := public.parse_time_hhmm(settings->>'auto_clock_out_time');
  local_as_of := timezone(tz, as_of);
  local_in := timezone(tz, clock_in_at);
  d := date_trunc('day', local_in)::date;
  while d <= date_trunc('day', local_as_of)::date loop
    candidate := (d + auto_t) at time zone tz;
    if candidate <= as_of and clock_in_at < candidate then
      best := candidate;
    end if;
    d := d + 1;
  end loop;
  return best;
end;
$$;

create or replace function public.timeclock_close_open_entry(
  p_entry public.time_clock_entries,
  p_clock_out_at timestamptz,
  p_reason text default null
)
returns void
language plpgsql
as $$
declare
  break_mins integer := 0;
  seg jsonb;
begin
  if p_entry.break_start_at is not null and p_entry.break_end_at is null then
    break_mins := greatest(
      0,
      floor(extract(epoch from (p_clock_out_at - p_entry.break_start_at)) / 60.0)::integer
    );
    seg := jsonb_build_object(
      'start', p_entry.break_start_at,
      'end', p_clock_out_at,
      'minutes', break_mins
    );
    update public.time_clock_entries
    set
      clock_out_at = p_clock_out_at,
      break_end_at = p_clock_out_at,
      break_minutes = coalesce(break_minutes, 0) + break_mins,
      break_segments = coalesce(break_segments, '[]'::jsonb) || seg
    where id = p_entry.id;
  else
    update public.time_clock_entries
    set clock_out_at = p_clock_out_at
    where id = p_entry.id;
  end if;
end;
$$;

create or replace function public.timeclock_apply_auto_clockouts()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  closed_count integer := 0;
  r public.time_clock_entries%rowtype;
  boundary timestamptz;
  now_ts timestamptz := now();
begin
  for r in
    select *
    from public.time_clock_entries t
    where t.clock_out_at is null
  loop
    boundary := public.timeclock_auto_clockout_boundary(r.clock_in_at, now_ts);
    if boundary is not null then
      perform public.timeclock_close_open_entry(r, boundary, 'auto');
      closed_count := closed_count + 1;
    end if;
  end loop;
  return closed_count;
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
  open_row public.time_clock_entries%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_timeclock(auth.uid()) and not public.is_manager(auth.uid()) then
    raise exception 'Not allowed';
  end if;

  perform public.timeclock_apply_auto_clockouts();

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
  seg jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_timeclock(auth.uid()) and not public.is_manager(auth.uid()) then
    raise exception 'Not allowed';
  end if;

  perform public.timeclock_apply_auto_clockouts();

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
    seg := jsonb_build_object(
      'start', open_row.break_start_at,
      'end', now_ts,
      'minutes', break_mins
    );
    update public.time_clock_entries
    set
      break_end_at = now_ts,
      break_minutes = coalesce(break_minutes, 0) + break_mins,
      break_segments = coalesce(break_segments, '[]'::jsonb) || seg
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

  perform public.timeclock_close_open_entry(open_row, now_ts, 'out');

  return jsonb_build_object(
    'ok', true,
    'action', 'out',
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'at', now_ts
  );
end;
$$;
