-- Employment classification for roster and schedule display.
-- Existing employees are updated below; new employees default to full-time.
alter table public.employees
  add column if not exists employment_status text not null default 'full-time';

alter table public.employees
  alter column employment_status set default 'full-time';

alter table public.employees
  drop constraint if exists employees_employment_status_check;

alter table public.employees
  add constraint employees_employment_status_check
  check (employment_status in ('part-time', 'full-time'));

update public.employees
set employment_status = 'full-time'
where employment_status is distinct from 'full-time';

comment on column public.employees.employment_status is
  'Employment classification: part-time or full-time.';
