-- Enable Realtime on employees so tip points and roster edits sync across devices.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'employees'
  ) then
    alter publication supabase_realtime add table public.employees;
  end if;
end $$;
