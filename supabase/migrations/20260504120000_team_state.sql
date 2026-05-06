-- Single-row shared state for web + mobile (schedule blobs, templates, draft, messaging prefs).
-- One site for now: singleton id = 'main'. Safe to re-run.

create table if not exists public.team_state (
  id text primary key default 'main',
  schedule_assignments jsonb not null default '{}'::jsonb,
  schedule_templates jsonb not null default '[]'::jsonb,
  draft_schedule jsonb not null default '{}'::jsonb,
  messaging_templates jsonb not null default '{"voice":""}'::jsonb,
  current_restaurant_id text not null default 'rp-9',
  updated_at timestamptz not null default now()
);

drop trigger if exists team_state_set_updated_at on public.team_state;
create trigger team_state_set_updated_at
before update on public.team_state
for each row
execute procedure public.set_updated_at();

alter table public.team_state enable row level security;

drop policy if exists "team_state_select_authenticated" on public.team_state;
create policy "team_state_select_authenticated"
on public.team_state for select
to authenticated
using (true);

drop policy if exists "team_state_insert_manager" on public.team_state;
create policy "team_state_insert_manager"
on public.team_state for insert
to authenticated
with check (public.is_manager(auth.uid()));

drop policy if exists "team_state_update_manager" on public.team_state;
create policy "team_state_update_manager"
on public.team_state for update
to authenticated
using (public.is_manager(auth.uid()))
with check (public.is_manager(auth.uid()));

drop policy if exists "team_state_delete_manager" on public.team_state;
create policy "team_state_delete_manager"
on public.team_state for delete
to authenticated
using (public.is_manager(auth.uid()));

insert into public.team_state (id) values ('main')
on conflict (id) do nothing;
