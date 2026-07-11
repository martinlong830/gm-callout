-- team_state rows carry multi-MB JSON (schedule_assignments, draft_schedule, templates).
-- postgres_changes sends the full NEW row to every subscriber on each UPDATE — major Realtime egress.
-- Web + mobile now use Realtime Broadcast pings on team_state_sync:{id} and selective REST fetch.
-- Apply this migration in Supabase SQL Editor or via `supabase db push`.
-- See docs/supabase-egress.md for verification and Usage dashboard guidance.

do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'team_state'
  ) then
    alter publication supabase_realtime drop table public.team_state;
  end if;
end $$;

comment on table public.team_state is
  'Shared schedule/timecard state. Not on supabase_realtime — clients sync via broadcast + REST.';
