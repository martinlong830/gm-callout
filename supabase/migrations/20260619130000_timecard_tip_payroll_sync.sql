-- Sync timecard tip pool dollars and dishwasher tips across devices (team_state JSON blobs).

alter table public.team_state
  add column if not exists timecard_week_tip_pool jsonb not null default '{}'::jsonb;

alter table public.team_state
  add column if not exists timecard_dishwasher_tips jsonb not null default '{}'::jsonb;

comment on column public.team_state.timecard_week_tip_pool is
  'Per pay-week tip pool inputs (Square in house, cash, SQ/GH/DD). Key = week start ISO.';

comment on column public.team_state.timecard_dishwasher_tips is
  'Per pay-week dishwasher/delivery tip amounts. Key = week start ISO; values map emp/day/location keys to dollars.';

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'team_state'
  ) then
    alter publication supabase_realtime add table public.team_state;
  end if;
end $$;
