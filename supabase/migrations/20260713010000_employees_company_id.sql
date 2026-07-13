-- Scope roster rows to a company so new tenants do not see Red Poke staff.
-- Existing employees are backfilled to the Red Poke company id.

alter table public.employees
  add column if not exists company_id uuid references public.companies (id) on delete cascade;

update public.employees
set company_id = 'a0000000-0000-4000-8000-000000000001'
where company_id is null;

create index if not exists employees_company_id_idx
  on public.employees (company_id);

-- Display names are unique per company (not globally).
drop index if exists employees_display_name_lower;
create unique index if not exists employees_company_display_name_lower
  on public.employees (company_id, lower(display_name))
  where company_id is not null;

create or replace function public.current_profile_company_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    p.company_id,
    'a0000000-0000-4000-8000-000000000001'::uuid
  )
  from public.profiles p
  where p.id = auth.uid();
$$;

revoke all on function public.current_profile_company_id() from public;
grant execute on function public.current_profile_company_id() to authenticated;

-- Default company_id on insert from the signed-in profile when omitted.
create or replace function public.employees_set_company_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  cid uuid;
begin
  if new.company_id is null then
    cid := public.current_profile_company_id();
    if cid is null then
      cid := 'a0000000-0000-4000-8000-000000000001'::uuid;
    end if;
    new.company_id := cid;
  end if;
  return new;
end;
$$;

drop trigger if exists employees_set_company_id on public.employees;
create trigger employees_set_company_id
before insert on public.employees
for each row
execute procedure public.employees_set_company_id();

-- RLS: same-company only (managers / self still gated by existing role checks).
drop policy if exists "employees_select_team" on public.employees;
create policy "employees_select_team"
on public.employees for select
to authenticated
using (
  company_id is not distinct from public.current_profile_company_id()
  or auth_user_id = auth.uid()
);

drop policy if exists "employees_insert_team" on public.employees;
create policy "employees_insert_team"
on public.employees for insert
to authenticated
with check (
  (
    public.is_manager(auth.uid())
    and company_id is not distinct from public.current_profile_company_id()
  )
  or (
    auth_user_id is not null
    and auth_user_id = auth.uid()
    and company_id is not distinct from public.current_profile_company_id()
  )
);

drop policy if exists "employees_update_team" on public.employees;
create policy "employees_update_team"
on public.employees for update
to authenticated
using (
  (
    public.is_manager(auth.uid())
    and company_id is not distinct from public.current_profile_company_id()
  )
  or auth_user_id = auth.uid()
)
with check (
  (
    public.is_manager(auth.uid())
    and company_id is not distinct from public.current_profile_company_id()
  )
  or (
    auth_user_id = auth.uid()
    and company_id is not distinct from public.current_profile_company_id()
  )
);

drop policy if exists "employees_delete_managers" on public.employees;
create policy "employees_delete_managers"
on public.employees for delete
to authenticated
using (
  public.is_manager(auth.uid())
  and company_id is not distinct from public.current_profile_company_id()
);
