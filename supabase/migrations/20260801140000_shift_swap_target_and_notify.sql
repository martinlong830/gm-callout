-- Targeted shift-swap offers: only the named cover (or everyone) can see open offers.
-- Also notify the targeted teammate when an offer is posted to them.

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'staff_requests'
      and policyname = 'staff_requests_select_pending_swap_offers'
  ) then
    drop policy "staff_requests_select_pending_swap_offers" on public.staff_requests;
  end if;
end $$;

create policy "staff_requests_select_pending_swap_offers"
on public.staff_requests
for select
to authenticated
using (
  type = 'swap'
  and status = 'pending'
  and coalesce(payload->>'offeredShiftLabel', '') <> ''
  and coalesce(payload->>'swapOfferId', '') = ''
  and (
    coalesce(nullif(trim(payload->>'swapTargetEmployeeId'), ''), '') = ''
    or exists (
      select 1
      from public.employees e
      where e.auth_user_id = auth.uid()
        and e.id::text = trim(payload->>'swapTargetEmployeeId')
    )
  )
);

create or replace function public.staff_requests_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  company_id uuid;
  restaurant_id text;
  team_state_id text;
  requester_name text;
  type_label text;
  title text;
  body text;
  recipient_ids uuid[];
  decision text;
  target_employee_id text;
  target_auth_id uuid;
begin
  select p.company_id into company_id
  from public.profiles p
  where p.id = coalesce(new.requester_id, old.requester_id);

  select public.employee_store_scope(e.usual_restaurant, e.meta)
  into restaurant_id
  from public.employees e
  where e.auth_user_id = new.requester_id
  limit 1;

  if company_id is not null then
    select c.team_state_id into team_state_id
    from public.companies c
    where c.id = company_id;
  end if;

  requester_name := coalesce(
    nullif(trim(new.payload->>'employeeName'), ''),
    (select display_name from public.profiles where id = new.requester_id),
    'Employee'
  );

  type_label := case new.type
    when 'availability' then 'Availability'
    when 'timeoff' then 'Time off'
    when 'swap' then 'Shift swap'
    when 'callout' then 'Callout'
    else initcap(coalesce(new.type, 'Request'))
  end;

  if tg_op = 'INSERT' and new.status = 'pending' then
    if new.type = 'availability' then
      title := 'Availability submitted';
      body := requester_name || ' submitted availability.';
    else
      title := type_label || ' submitted';
      body := requester_name || ' submitted a ' || lower(type_label) || ' request.';
    end if;

    select coalesce(array_agg(uid), '{}')
    into recipient_ids
    from public.notification_manager_recipient_ids(company_id, restaurant_id) as uid;

    perform public.insert_app_notifications(
      recipient_ids,
      company_id,
      team_state_id,
      restaurant_id,
      case when new.type = 'availability' then 'availability_submitted' else 'request_submitted' end,
      title,
      body,
      jsonb_build_object(
        'staffRequestId', new.id,
        'requestType', new.type,
        'requesterId', new.requester_id,
        'restaurantId', restaurant_id,
        'swapTargetEmployeeId', new.payload->>'swapTargetEmployeeId'
      )
    );

    -- Targeted swap offer: separately notify the named cover worker.
    if new.type = 'swap'
       and coalesce(new.payload->>'swapOfferId', '') = ''
    then
      target_employee_id := nullif(trim(new.payload->>'swapTargetEmployeeId'), '');
      if target_employee_id is not null then
        select e.auth_user_id into target_auth_id
        from public.employees e
        where e.id::text = target_employee_id
        limit 1;
        if target_auth_id is not null
           and not (target_auth_id = any (recipient_ids))
        then
          perform public.insert_app_notifications(
            array[target_auth_id],
            company_id,
            team_state_id,
            restaurant_id,
            'swap_offer_targeted',
            'Shift swap offer',
            requester_name || ' offered you a shift swap.',
            jsonb_build_object(
              'staffRequestId', new.id,
              'requestType', new.type,
              'requesterId', new.requester_id,
              'restaurantId', restaurant_id,
              'swapTargetEmployeeId', target_employee_id
            )
          );
        end if;
      end if;
    end if;
  elsif tg_op = 'UPDATE'
    and old.status is distinct from new.status
    and new.status in ('approved', 'rejected', 'closed')
    and new.type in ('timeoff', 'swap', 'callout')
  then
    decision := case
      when new.status = 'approved' then 'approved'
      when new.status = 'rejected' then 'declined'
      else 'closed'
    end;
    title := type_label || ' ' || decision;
    body := 'Your ' || lower(type_label) || ' request was ' || decision || '.';

    perform public.insert_app_notifications(
      array[new.requester_id],
      company_id,
      team_state_id,
      restaurant_id,
      'request_decided',
      title,
      body,
      jsonb_build_object(
        'staffRequestId', new.id,
        'requestType', new.type,
        'status', new.status,
        'decision', decision
      )
    );
  end if;

  return new;
end;
$$;
