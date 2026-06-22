-- Let employees see teammates' open shift-swap offers (not acceptances or closed rows).

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'staff_requests'
      and policyname = 'staff_requests_select_pending_swap_offers'
  ) then
    create policy "staff_requests_select_pending_swap_offers"
    on public.staff_requests
    for select
    to authenticated
    using (
      type = 'swap'
      and status = 'pending'
      and coalesce(payload->>'offeredShiftLabel', '') <> ''
      and coalesce(payload->>'swapOfferId', '') = ''
    );
  end if;
end $$;
