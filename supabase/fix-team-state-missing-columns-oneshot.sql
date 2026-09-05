-- Apply in Supabase SQL editor (production) so holidays / reviews / tip % work.
-- Safe to re-run.

alter table public.team_state
  add column if not exists company_holidays jsonb not null default '{"v":1,"holidays":[]}'::jsonb;

alter table public.team_state
  add column if not exists schedule_reviews jsonb not null default '{"v":1,"items":[]}'::jsonb;

alter table public.team_state
  add column if not exists timecard_tip_takehome_pct jsonb not null default '{}'::jsonb;

comment on column public.team_state.company_holidays is
  'Company holiday calendar: { v: 1, holidays: [{ id, iso, name }] }.';
comment on column public.team_state.schedule_reviews is
  'Frozen manager↔admin schedule review proposals.';
comment on column public.team_state.timecard_tip_takehome_pct is
  'Per-employee tip take-home percent map.';
