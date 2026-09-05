-- Enable Realtime postgres_changes for shared schedule sync across manager accounts.
-- Safe to re-run.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'team_state'
  ) then
    execute 'alter publication supabase_realtime add table public.team_state';
  end if;
exception
  when undefined_object then
    /* Publication missing in non-Supabase envs — ignore. */
    null;
  when duplicate_object then
    null;
end $$;
