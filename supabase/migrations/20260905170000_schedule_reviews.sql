-- Manager ↔ admin schedule review proposals (frozen snapshots).
-- Safe to re-run.

alter table public.team_state
  add column if not exists schedule_reviews jsonb not null default '{"v":1,"items":[]}'::jsonb;

comment on column public.team_state.schedule_reviews is
  'Frozen schedule review proposals: { v:1, items:[{ id, restaurantId, weekMondayIso, status, proposal, baseline, cells, ... }] }. Web manager/admin only.';
