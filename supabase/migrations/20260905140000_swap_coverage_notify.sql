-- Distinct manager notifications for shift-coverage offer vs accept.
-- Keeps targeted-cover notify; improves manager copy + notification type for routing/push.

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
  route_subsection text;
  notif_data jsonb;
  notif_type text;
  shift_label text;
  is_swap_acceptance boolean;
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
    when 'swap' then 'Shift coverage'
    when 'callout' then 'Callout'
    else initcap(coalesce(new.type, 'Request'))
  end;

  route_subsection := case new.type
    when 'availability' then 'availability'
    when 'timeoff' then 'timeoff'
    when 'swap' then 'swap'
    when 'callout' then 'callout'
    else null
  end;

  shift_label := coalesce(
    nullif(trim(new.payload->>'offeredShiftLabel'), ''),
    nullif(trim(new.payload->'offeredShift'->>'timeLabel'), ''),
    ''
  );

  is_swap_acceptance :=
    new.type = 'swap'
    and coalesce(nullif(trim(new.payload->>'swapOfferId'), ''), '') <> '';

  notif_data := jsonb_build_object(
    'staffRequestId', new.id,
    'requestId', new.id,
    'requestType', new.type,
    'subsection', route_subsection,
    'requesterId', new.requester_id,
    'restaurantId', restaurant_id,
    'swapTargetEmployeeId', new.payload->>'swapTargetEmployeeId',
    'swapOfferId', new.payload->>'swapOfferId',
    'offeredShiftLabel', shift_label
  );

  if tg_op = 'INSERT' and new.status = 'pending' then
    if new.type = 'availability' then
      notif_type := 'availability_submitted';
      title := 'Availability submitted';
      body := requester_name || ' submitted availability.';
    elsif new.type = 'swap' and is_swap_acceptance then
      notif_type := 'swap_accepted_pending';
      title := 'Coverage accepted — approve';
      body := requester_name || ' accepted a coverage offer — awaiting your approval.';
    elsif new.type = 'swap' then
      notif_type := 'swap_offer_submitted';
      title := 'Shift coverage requested';
      if shift_label <> '' then
        body := requester_name || ' requested shift coverage: ' || shift_label || '.';
      else
        body := requester_name || ' requested shift coverage.';
      end if;
    else
      notif_type := 'request_submitted';
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
      notif_type,
      title,
      body,
      notif_data || jsonb_build_object('type', notif_type)
    );

    -- Targeted swap offer: separately notify the named cover worker.
    if new.type = 'swap'
       and not is_swap_acceptance
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
            'Shift coverage offer',
            requester_name || ' offered you a shift to cover.',
            notif_data || jsonb_build_object('type', 'swap_offer_targeted')
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
      notif_data || jsonb_build_object(
        'status', new.status,
        'decision', decision
      )
    );
  end if;

  return new;
end;
$$;
