-- Recovery email on profiles + password reset tokens (server-only table).

alter table public.profiles
  add column if not exists recovery_email text,
  add column if not exists recovery_email_norm text;

create unique index if not exists profiles_recovery_email_norm_unique
  on public.profiles (recovery_email_norm)
  where recovery_email_norm is not null;

create table if not exists public.portal_password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists portal_password_reset_tokens_profile_id_idx
  on public.portal_password_reset_tokens (profile_id);

create index if not exists portal_password_reset_tokens_token_hash_idx
  on public.portal_password_reset_tokens (token_hash);

alter table public.portal_password_reset_tokens enable row level security;

-- No client policies: only service role (Node server) reads/writes reset tokens.
