-- Manager-entered pay rate per roster row (used on team member detail).

alter table public.employees
  add column if not exists hourly_rate numeric(8, 2);

comment on column public.employees.hourly_rate is 'Hourly wage in USD; manager-editable on team profile.';
