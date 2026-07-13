-- Inspect / clean duplicate portal profiles that break Red Poke manager sign-in.
-- Error symptom: "JSON object requested, multiple (or no) rows returned" (PGRST116)
-- when login_name_norm matches more than one profiles row under an unscoped lookup.
--
-- Red Poke company id:
--   a0000000-0000-4000-8000-000000000001
-- Typical manager login norms:
--   'martin long', 'ongi management'

-- 1) Find duplicate login names (same login_name_norm across rows)
select
  login_name_norm,
  count(*) as n,
  array_agg(id order by created_at nulls last, id) as profile_ids,
  array_agg(company_id order by created_at nulls last, id) as company_ids,
  array_agg(coalesce(login_name, display_name) order by created_at nulls last, id) as names,
  array_agg(role order by created_at nulls last, id) as roles
from public.profiles
where login_name_norm is not null
group by login_name_norm
having count(*) > 1
order by n desc, login_name_norm;

-- 2) Detail for Red Poke managers (adjust names if needed)
select
  p.id,
  p.login_name,
  p.login_name_norm,
  p.display_name,
  p.role,
  p.company_id,
  c.name as company_name,
  p.internal_auth_email,
  p.recovery_email,
  p.created_at
from public.profiles p
left join public.companies c on c.id = p.company_id
where p.login_name_norm in ('martin long', 'ongi management')
order by p.login_name_norm, p.company_id nulls first, p.created_at nulls last;

-- 3) Prefer keeping the Red Poke (or legacy null-company) manager; list extras to delete.
--    REVIEW the ids before deleting. Deleting a profile does NOT delete auth.users —
--    remove orphaned auth users in the Supabase Auth UI or via admin API after.
with keepers as (
  select distinct on (login_name_norm)
    id,
    login_name_norm,
    company_id
  from public.profiles
  where login_name_norm in ('martin long', 'ongi management')
  order by
    login_name_norm,
    case
      when company_id = 'a0000000-0000-4000-8000-000000000001' then 0
      when company_id is null then 1
      else 2
    end,
    created_at nulls last,
    id
)
select
  p.id as delete_candidate_id,
  p.login_name_norm,
  p.company_id,
  p.internal_auth_email,
  k.id as keep_id
from public.profiles p
join keepers k on k.login_name_norm = p.login_name_norm
where p.id <> k.id
  and p.login_name_norm in ('martin long', 'ongi management');

-- 4a) Optional: attach legacy null-company Red Poke managers to the real company
-- update public.profiles
-- set company_id = 'a0000000-0000-4000-8000-000000000001'
-- where company_id is null
--   and login_name_norm in ('martin long', 'ongi management')
--   and role = 'manager';

-- 4b) Optional: after reviewing delete_candidate_id rows above, remove extras that were
--     created while testing new-company signup (NOT the Red Poke keeper).
--     Also delete matching auth.users via Dashboard → Authentication, or:
-- delete from auth.users where id in ('…');  -- only for confirmed extras
-- delete from public.profiles where id in ('…');
