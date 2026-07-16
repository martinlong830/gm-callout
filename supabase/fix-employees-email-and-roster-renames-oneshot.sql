-- Oneshot for Supabase SQL Editor (same as migration 20260716090000).
-- After applying, also run: node scripts/rename-roster-employees-oneshot.js

-- employees.email column + roster display renames (Maeve / Jon / Charles).
-- Prefer also running: node scripts/rename-roster-employees-oneshot.js
-- to rewrite schedule/request JSON worker-name strings and backfill emails.

alter table public.employees
  add column if not exists email text not null default '';

-- ANGELYN / ANGEL GELLA → MAEVE WILLIAMS (skip if Maeve already exists as another row)
update public.employees
set
  first_name = 'MAEVE',
  last_name = 'WILLIAMS',
  display_name = 'MAEVE WILLIAMS'
where upper(trim(display_name)) in ('ANGELYN GELLA', 'ANGEL GELLA')
  and not exists (
    select 1 from public.employees e2
    where e2.id <> employees.id
      and upper(trim(e2.display_name)) = 'MAEVE WILLIAMS'
  );

update public.profiles p
set display_name = 'MAEVE WILLIAMS'
from public.employees e
where e.auth_user_id = p.id
  and upper(trim(e.display_name)) = 'MAEVE WILLIAMS'
  and upper(trim(coalesce(p.display_name, ''))) in ('ANGELYN GELLA', 'ANGEL GELLA');

-- JONG SARDUA → JON ARELLANO
update public.employees
set
  first_name = 'JON',
  last_name = 'ARELLANO',
  display_name = 'JON ARELLANO'
where upper(trim(display_name)) = 'JONG SARDUA'
  and not exists (
    select 1 from public.employees e2
    where e2.id <> employees.id
      and upper(trim(e2.display_name)) = 'JON ARELLANO'
  );

update public.profiles p
set display_name = 'JON ARELLANO'
from public.employees e
where e.auth_user_id = p.id
  and upper(trim(e.display_name)) = 'JON ARELLANO'
  and upper(trim(coalesce(p.display_name, ''))) = 'JONG SARDUA';

-- SIED / SEID SUMOG - OY → CHARLES JAKOB ZACANI
update public.employees
set
  first_name = 'CHARLES JAKOB',
  last_name = 'ZACANI',
  display_name = 'CHARLES JAKOB ZACANI'
where upper(trim(regexp_replace(display_name, '\s+', ' ', 'g'))) in (
    'SIED SUMOG - OY',
    'SEID SUMOG - OY',
    'SIED SUMOG-OY',
    'SEID SUMOG-OY'
  )
  and not exists (
    select 1 from public.employees e2
    where e2.id <> employees.id
      and upper(trim(e2.display_name)) = 'CHARLES JAKOB ZACANI'
  );

update public.profiles p
set display_name = 'CHARLES JAKOB ZACANI'
from public.employees e
where e.auth_user_id = p.id
  and upper(trim(e.display_name)) = 'CHARLES JAKOB ZACANI'
  and upper(trim(regexp_replace(coalesce(p.display_name, ''), '\s+', ' ', 'g'))) in (
    'SIED SUMOG - OY',
    'SEID SUMOG - OY'
  );

-- Backfill employee email from profile recovery email when empty.
update public.employees e
set
  email = lower(trim(p.recovery_email)),
  meta = coalesce(e.meta, '{}'::jsonb)
    || jsonb_build_object('email', lower(trim(p.recovery_email)))
from public.profiles p
where e.auth_user_id = p.id
  and coalesce(trim(e.email), '') = ''
  and coalesce(trim(p.recovery_email), '') <> '';

-- Ensure login_name is populated for legacy profiles (username stays delinked from display).
update public.profiles
set
  login_name = coalesce(nullif(trim(login_name), ''), nullif(trim(display_name), ''), 'User'),
  login_name_norm = lower(
    trim(coalesce(nullif(trim(login_name), ''), nullif(trim(display_name), ''), 'User'))
  )
where login_name is null
   or trim(login_name) = ''
   or login_name_norm is null
   or trim(login_name_norm) = '';
