-- Timeclock kiosk: off-schedule punches (null schedule_shift_id), store attribution, audit log.

alter table public.time_clock_entries
  add column if not exists clock_restaurant_id text;

comment on column public.time_clock_entries.clock_restaurant_id is
  'Store where the kiosk punch occurred (rp-9 / rp-8). Used for multi-location timecards when schedule_shift_id is null.';

create or replace function public.timeclock_resolve_restaurant_id(
  p_restaurant_id text,
  p_usual_restaurant text
)
returns text
language plpgsql
immutable
as $$
declare
  rid text := nullif(trim(coalesce(p_restaurant_id, '')), '');
begin
  if rid in ('rp-9', 'rp-8') then
    return rid;
  end if;
  rid := nullif(trim(coalesce(p_usual_restaurant, '')), '');
  if rid in ('rp-9', 'rp-8') then
    return rid;
  end if;
  return 'rp-9';
end;
$$;

create or replace function public.timeclock_edit_history_segment(
  p_action text,
  p_at timestamptz
)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_array(
    jsonb_build_object(
      'at', p_at,
      'by', 'timeclock',
      'changes', jsonb_build_object(
        'kiosk_punch', jsonb_build_object('from', null, 'to', p_action)
      )
    )
  );
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
      and open_row.break_end_at is null,
    'open_entry_id', open_row.id,
    'open_schedule_shift_id', open_row.schedule_shift_id,
    'open_clock_restaurant_id', open_row.clock_restaurant_id
  );
end;
$$;

create or replace function public.timeclock_punch_with_action(
  pin_input text,
  punch_action text,
  p_restaurant_id text default null,
  p_schedule_shift_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  pin char(4);
  emp public.employees%rowtype;
  open_row public.time_clock_entries%rowtype;
  new_row public.time_clock_entries%rowtype;
  action text;
  now_ts timestamptz := now();
  break_mins integer;
  seg jsonb;
  restaurant_id text;
  shift_id text;
  hist jsonb;
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

  restaurant_id := public.timeclock_resolve_restaurant_id(p_restaurant_id, emp.usual_restaurant);
  shift_id := nullif(trim(coalesce(p_schedule_shift_id, '')), '');

  select * into open_row
  from public.time_clock_entries t
  where t.employee_id = emp.id and t.clock_out_at is null
  order by t.clock_in_at desc
  limit 1;

  if action = 'in' then
    if open_row.id is not null then
      return jsonb_build_object('ok', false, 'error', 'already_in', 'display_name', emp.display_name);
    end if;
    hist := public.timeclock_edit_history_segment('in', now_ts);
    insert into public.time_clock_entries (
      employee_id,
      clock_in_at,
      schedule_shift_id,
      clock_restaurant_id,
      edit_history
    )
    values (
      emp.id,
      now_ts,
      shift_id,
      restaurant_id,
      hist
    )
    returning * into new_row;
    return jsonb_build_object(
      'ok', true,
      'action', 'in',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts,
      'entry_id', new_row.id,
      'schedule_shift_id', new_row.schedule_shift_id,
      'clock_restaurant_id', new_row.clock_restaurant_id,
      'off_schedule', new_row.schedule_shift_id is null
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
    set
      break_start_at = now_ts,
      break_end_at = null,
      edit_history = coalesce(edit_history, '[]'::jsonb) || public.timeclock_edit_history_segment('break_start', now_ts)
    where id = open_row.id;
    return jsonb_build_object(
      'ok', true,
      'action', 'break_start',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts,
      'entry_id', open_row.id,
      'schedule_shift_id', open_row.schedule_shift_id,
      'clock_restaurant_id', open_row.clock_restaurant_id,
      'off_schedule', open_row.schedule_shift_id is null
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
      break_segments = coalesce(break_segments, '[]'::jsonb) || seg,
      edit_history = coalesce(edit_history, '[]'::jsonb) || public.timeclock_edit_history_segment('break_end', now_ts)
    where id = open_row.id;
    return jsonb_build_object(
      'ok', true,
      'action', 'break_end',
      'employee_id', emp.id,
      'display_name', emp.display_name,
      'at', now_ts,
      'break_minutes', break_mins,
      'entry_id', open_row.id,
      'schedule_shift_id', open_row.schedule_shift_id,
      'clock_restaurant_id', open_row.clock_restaurant_id,
      'off_schedule', open_row.schedule_shift_id is null
    );
  end if;

  perform public.timeclock_close_open_entry(open_row, now_ts, 'out');
  update public.time_clock_entries
  set edit_history = coalesce(edit_history, '[]'::jsonb) || public.timeclock_edit_history_segment('out', now_ts)
  where id = open_row.id;

  return jsonb_build_object(
    'ok', true,
    'action', 'out',
    'employee_id', emp.id,
    'display_name', emp.display_name,
    'at', now_ts,
    'entry_id', open_row.id,
    'schedule_shift_id', open_row.schedule_shift_id,
    'clock_restaurant_id', open_row.clock_restaurant_id,
    'off_schedule', open_row.schedule_shift_id is null
  );
end;
$$;

grant execute on function public.timeclock_resolve_restaurant_id(text, text) to authenticated;
grant execute on function public.timeclock_edit_history_segment(text, timestamptz) to authenticated;
