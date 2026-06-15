-- Allow managers to delete punch rows when clearing timecard edits (VL/SL-only days).

drop policy if exists "time_clock_entries_delete_managers" on public.time_clock_entries;
create policy "time_clock_entries_delete_managers"
on public.time_clock_entries for delete
to authenticated
using (public.is_manager(auth.uid()));
