-- Timecards: unpaid break, schedule link, manager edits + audit trail.

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

comment on column public.time_clock_entries.break_minutes is 'Unpaid break minutes deducted from paid time.';
comment on column public.time_clock_entries.schedule_shift_id is 'Links punch to published schedule row id when matched.';
comment on column public.time_clock_entries.edit_history is 'Manager edit audit log (json array).';

drop policy if exists "time_clock_entries_update_managers" on public.time_clock_entries;
create policy "time_clock_entries_update_managers"
on public.time_clock_entries for update
to authenticated
using (public.is_manager(auth.uid()))
with check (public.is_manager(auth.uid()));

drop policy if exists "time_clock_entries_insert_managers" on public.time_clock_entries;
create policy "time_clock_entries_insert_managers"
on public.time_clock_entries for insert
to authenticated
with check (public.is_manager(auth.uid()));
