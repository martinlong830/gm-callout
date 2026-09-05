-- Harden schedule revision history access (grants + allow source=auto).
-- Safe to re-run.

alter table if exists public.team_state_schedule_revisions
  drop constraint if exists team_state_schedule_revisions_source_check;

alter table if exists public.team_state_schedule_revisions
  add constraint team_state_schedule_revisions_source_check
  check (source in ('persist', 'publish', 'hard_revert', 'manual', 'pre_revert', 'auto'));

grant select, insert, delete on table public.team_state_schedule_revisions to authenticated;
grant select, insert, update, delete on table public.team_state_schedule_revisions to service_role;

-- Ensure manager helper is executable for RLS policies.
grant execute on function public.is_manager(uuid) to authenticated;
grant execute on function public.is_manager(uuid) to service_role;
