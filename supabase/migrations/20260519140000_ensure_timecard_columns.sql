-- Ensure timecard columns exist (safe if 20260518120000 was never applied).

alter table public.time_clock_entries
  add column if not exists break_minutes integer not null default 0;

alter table public.time_clock_entries
  add column if not exists schedule_shift_id text;

alter table public.time_clock_entries
  add column if not exists edit_history jsonb not null default '[]'::jsonb;

alter table public.time_clock_entries
  drop constraint if exists time_clock_entries_break_minutes_check;

alter table public.time_clock_entries
  add constraint time_clock_entries_break_minutes_check
  check (break_minutes >= 0);

-- Manager save: works with or without optional columns (uses only core fields when extras missing).
create or replace function public.manager_save_time_clock_entry(
  p_entry_id uuid,
  p_employee_id uuid,
  p_clock_in_at timestamptz,
  p_clock_out_at timestamptz,
  p_break_minutes integer default 0,
  p_schedule_shift_id text default null,
  p_edit_history jsonb default '[]'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_id uuid;
  row public.time_clock_entries%rowtype;
  has_break boolean;
  has_shift_id boolean;
  has_history boolean;
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  if not public.is_manager(auth.uid()) then
    raise exception 'Only managers can save timecards';
  end if;
  if p_employee_id is null then
    return jsonb_build_object('ok', false, 'error', 'missing_employee');
  end if;
  if p_clock_in_at is null then
    return jsonb_build_object('ok', false, 'error', 'missing_clock_in');
  end if;
  if not exists (select 1 from public.employees e where e.id = p_employee_id) then
    return jsonb_build_object('ok', false, 'error', 'unknown_employee');
  end if;

  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_entries' and column_name = 'break_minutes'
  ) into has_break;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_entries' and column_name = 'schedule_shift_id'
  ) into has_shift_id;
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'time_clock_entries' and column_name = 'edit_history'
  ) into has_history;

  target_id := p_entry_id;

  if target_id is not null then
    if has_break and has_shift_id and has_history then
      update public.time_clock_entries
      set
        clock_in_at = p_clock_in_at,
        clock_out_at = p_clock_out_at,
        break_minutes = coalesce(p_break_minutes, 0),
        schedule_shift_id = p_schedule_shift_id,
        edit_history = coalesce(p_edit_history, '[]'::jsonb)
      where id = target_id;
    else
      update public.time_clock_entries
      set clock_in_at = p_clock_in_at, clock_out_at = p_clock_out_at
      where id = target_id;
    end if;
    if not found then
      target_id := null;
    end if;
  end if;

  if target_id is null then
    select t.id into target_id
    from public.time_clock_entries t
    where t.employee_id = p_employee_id and t.clock_out_at is null
    order by t.clock_in_at desc
    limit 1;
  end if;

  if target_id is not null then
    if has_break and has_shift_id and has_history then
      update public.time_clock_entries
      set
        clock_in_at = p_clock_in_at,
        clock_out_at = p_clock_out_at,
        break_minutes = coalesce(p_break_minutes, 0),
        schedule_shift_id = p_schedule_shift_id,
        edit_history = coalesce(p_edit_history, '[]'::jsonb)
      where id = target_id;
    else
      update public.time_clock_entries
      set clock_in_at = p_clock_in_at, clock_out_at = p_clock_out_at
      where id = target_id;
    end if;
  else
    if has_break and has_shift_id and has_history then
      insert into public.time_clock_entries (
        employee_id, clock_in_at, clock_out_at, break_minutes, schedule_shift_id, edit_history
      )
      values (
        p_employee_id,
        p_clock_in_at,
        p_clock_out_at,
        coalesce(p_break_minutes, 0),
        p_schedule_shift_id,
        coalesce(p_edit_history, '[]'::jsonb)
      )
      returning id into target_id;
    else
      insert into public.time_clock_entries (employee_id, clock_in_at, clock_out_at)
      values (p_employee_id, p_clock_in_at, p_clock_out_at)
      returning id into target_id;
    end if;
  end if;

  select * into row from public.time_clock_entries where id = target_id;

  return jsonb_build_object(
    'ok', true,
    'id', row.id,
    'employee_id', row.employee_id,
    'clock_in_at', row.clock_in_at,
    'clock_out_at', row.clock_out_at
  );
end;
$$;

grant execute on function public.manager_save_time_clock_entry(
  uuid, uuid, timestamptz, timestamptz, integer, text, jsonb
) to authenticated;
