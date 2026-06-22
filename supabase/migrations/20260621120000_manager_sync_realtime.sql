-- VL/SL week extras + Realtime for staff_requests and time_clock_entries (multi-device manager sync).

alter table public.team_state
  add column if not exists timecard_week_extras jsonb not null default '{}'::jsonb;

comment on column public.team_state.timecard_week_extras is
  'Per pay-week manual VL/SL day entries. Key = week start_end ISO; values map emp@day keys to hours.';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'staff_requests'
  ) then
    alter publication supabase_realtime add table public.staff_requests;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'time_clock_entries'
  ) then
    alter publication supabase_realtime add table public.time_clock_entries;
  end if;
end $$;
