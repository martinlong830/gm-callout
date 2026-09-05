-- Company holidays (admin-managed). Shown on schedule day headers + Home upcoming list.
alter table public.team_state
  add column if not exists company_holidays jsonb not null default '{"v":1,"holidays":[]}'::jsonb;

comment on column public.team_state.company_holidays is
  'Company holiday calendar: { v: 1, holidays: [{ id, iso, name }] }. Visible to all roles; editable by admins.';
