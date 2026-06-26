-- When an employee clocks in at a store outside their team profile, include both locations.

create or replace function public.timeclock_expand_employee_restaurant_for_punch(
  p_employee_id uuid,
  p_restaurant_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rid text := nullif(trim(coalesce(p_restaurant_id, '')), '');
  home text;
begin
  if p_employee_id is null or rid not in ('rp-8', 'rp-9') then
    return;
  end if;

  select coalesce(nullif(trim(e.usual_restaurant), ''), 'rp-9')
  into home
  from public.employees e
  where e.id = p_employee_id;

  if not found or home = 'both' or home = rid then
    return;
  end if;

  update public.employees
  set usual_restaurant = 'both'
  where id = p_employee_id;
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
    perform public.timeclock_expand_employee_restaurant_for_punch(emp.id, restaurant_id);
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

grant execute on function public.timeclock_expand_employee_restaurant_for_punch(uuid, text) to authenticated;
