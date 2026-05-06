-- Coverage callout log (manager outreach from Schedule). Safe to re-run.

alter table public.team_state
  add column if not exists callout_history jsonb not null default '[]'::jsonb;
