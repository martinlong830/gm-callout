-- Published schedule weeks (Monday ISO keys) + device push tokens for notify.

alter table public.team_state
  add column if not exists schedule_published jsonb not null default '{}'::jsonb;

comment on column public.team_state.schedule_published is
  'Map of week-start Monday ISO (YYYY-MM-DD) -> true (or {publishedAt}) for employee-visible weeks.';

create table if not exists public.device_push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  company_id uuid,
  team_state_id text not null default 'main',
  expo_push_token text not null,
  platform text,
  updated_at timestamptz not null default now(),
  unique (user_id, expo_push_token)
);

create index if not exists device_push_tokens_team_state_id_idx
  on public.device_push_tokens (team_state_id);

create index if not exists device_push_tokens_company_id_idx
  on public.device_push_tokens (company_id);

drop trigger if exists device_push_tokens_set_updated_at on public.device_push_tokens;
create trigger device_push_tokens_set_updated_at
before update on public.device_push_tokens
for each row
execute procedure public.set_updated_at();

alter table public.device_push_tokens enable row level security;

drop policy if exists "device_push_tokens_select_own" on public.device_push_tokens;
create policy "device_push_tokens_select_own"
on public.device_push_tokens for select
to authenticated
using (auth.uid() = user_id);

drop policy if exists "device_push_tokens_insert_own" on public.device_push_tokens;
create policy "device_push_tokens_insert_own"
on public.device_push_tokens for insert
to authenticated
with check (auth.uid() = user_id);

drop policy if exists "device_push_tokens_update_own" on public.device_push_tokens;
create policy "device_push_tokens_update_own"
on public.device_push_tokens for update
to authenticated
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

drop policy if exists "device_push_tokens_delete_own" on public.device_push_tokens;
create policy "device_push_tokens_delete_own"
on public.device_push_tokens for delete
to authenticated
using (auth.uid() = user_id);
