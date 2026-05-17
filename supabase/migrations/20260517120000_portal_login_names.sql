-- Portal sign-in by display/login name (no email in the UI).
-- Server creates auth users with internal_auth_email; users sign in with login_name + password.

alter table public.profiles
  add column if not exists login_name text,
  add column if not exists login_name_norm text,
  add column if not exists internal_auth_email text;

create unique index if not exists profiles_login_name_norm_unique
  on public.profiles (login_name_norm)
  where login_name_norm is not null;

create unique index if not exists profiles_internal_auth_email_unique
  on public.profiles (internal_auth_email)
  where internal_auth_email is not null;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r text;
  st text;
  ln text;
  lnn text;
begin
  r := coalesce(nullif(new.raw_user_meta_data->>'role', ''), 'employee');
  if r not in ('manager', 'employee', 'timeclock') then
    r := 'employee';
  end if;

  st := nullif(new.raw_user_meta_data->>'staff_type', '');
  if st is not null and st not in ('Kitchen', 'Bartender', 'Server') then
    st := null;
  end if;

  ln := nullif(trim(new.raw_user_meta_data->>'login_name'), '');
  if ln is null then
    ln := nullif(trim(new.raw_user_meta_data->>'display_name'), '');
  end if;
  if ln is null then
    ln := split_part(coalesce(new.email, ''), '@', 1);
  end if;
  if ln is null or ln = '' then
    ln := 'User';
  end if;

  lnn := nullif(trim(new.raw_user_meta_data->>'login_name_norm'), '');
  if lnn is null then
    lnn := lower(trim(ln));
  end if;

  insert into public.profiles (
    id,
    role,
    display_name,
    phone,
    staff_type,
    login_name,
    login_name_norm,
    internal_auth_email
  )
  values (
    new.id,
    r,
    coalesce(nullif(trim(new.raw_user_meta_data->>'display_name'), ''), ln),
    nullif(trim(new.raw_user_meta_data->>'phone'), ''),
    st,
    ln,
    lnn,
    nullif(trim(coalesce(new.email, '')), '')
  );
  return new;
end;
$$;
