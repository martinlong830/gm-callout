-- Durable schedule change history for hard-revert (assignments + draft_schedule snapshots).
-- Safe to re-run.

create table if not exists public.team_state_schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  team_state_id text not null references public.team_state (id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  source text not null default 'persist'
    check (source in ('persist', 'publish', 'hard_revert', 'manual', 'pre_revert')),
  label text,
  content_hash text not null,
  schedule_assignments jsonb not null default '{}'::jsonb,
  draft_schedule jsonb not null default '{}'::jsonb,
  schedule_published jsonb
);

create index if not exists team_state_schedule_revisions_team_created_idx
  on public.team_state_schedule_revisions (team_state_id, created_at desc);

create index if not exists team_state_schedule_revisions_team_hash_idx
  on public.team_state_schedule_revisions (team_state_id, content_hash, created_at desc);

comment on table public.team_state_schedule_revisions is
  'Point-in-time schedule snapshots (assignments + draft incl. slot order) for manager hard-revert.';

alter table public.team_state_schedule_revisions enable row level security;

drop policy if exists "schedule_revisions_select_manager" on public.team_state_schedule_revisions;
create policy "schedule_revisions_select_manager"
on public.team_state_schedule_revisions for select
to authenticated
using (public.is_manager(auth.uid()));

drop policy if exists "schedule_revisions_insert_manager" on public.team_state_schedule_revisions;
create policy "schedule_revisions_insert_manager"
on public.team_state_schedule_revisions for insert
to authenticated
with check (public.is_manager(auth.uid()));

-- Managers may delete old revisions for retention cleanup.
drop policy if exists "schedule_revisions_delete_manager" on public.team_state_schedule_revisions;
create policy "schedule_revisions_delete_manager"
on public.team_state_schedule_revisions for delete
to authenticated
using (public.is_manager(auth.uid()));
