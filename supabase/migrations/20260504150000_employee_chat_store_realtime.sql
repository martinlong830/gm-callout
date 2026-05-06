-- Enable Realtime so mobile + web pick up message changes without full reload.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'employee_chat_store'
  ) then
    alter publication supabase_realtime add table public.employee_chat_store;
  end if;
end $$;
