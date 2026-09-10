-- Fix: PL/pgSQL variables op_id/op_type/payload conflicted with schedule_ops columns.
-- Safe to re-run (create or replace).

create or replace function public.apply_schedule_ops(
  p_ops jsonb,
  p_base_rev bigint default null,
  p_device_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
  v_op jsonb;
  v_op_id uuid;
  v_op_type text;
  v_payload jsonb;
  next_rev bigint;
  applied jsonb := '[]'::jsonb;
  conflicts jsonb := '[]'::jsonb;
  rest_id text;
  day_d date;
  role_t text;
  slot_k uuid;
  cell_rev bigint;
  sort_n integer;
  snap jsonb;
  week_mon date;
  i int;
  n int;
begin
  if uid is null then
    raise exception 'not authenticated';
  end if;
  if not public.is_manager(uid) then
    raise exception 'manager role required';
  end if;

  cid := public.current_profile_company_id();
  if cid is null then
    raise exception 'company_id required';
  end if;

  if p_ops is null or jsonb_typeof(p_ops) <> 'array' or jsonb_array_length(p_ops) = 0 then
    return jsonb_build_object(
      'ok', true,
      'schedule_rev', coalesce((select schedule_rev from public.schedule_company_state where company_id = cid), 0),
      'applied', '[]'::jsonb,
      'conflicts', '[]'::jsonb
    );
  end if;

  insert into public.schedule_company_state (company_id, schedule_rev)
  values (cid, 0)
  on conflict (company_id) do nothing;

  select schedule_rev into next_rev
  from public.schedule_company_state
  where company_id = cid
  for update;

  next_rev := coalesce(next_rev, 0);

  n := jsonb_array_length(p_ops);
  for i in 0 .. n - 1 loop
    v_op := p_ops -> i;
    v_op_id := nullif(v_op->>'op_id', '')::uuid;
    v_op_type := coalesce(nullif(v_op->>'op_type', ''), nullif(v_op->>'type', ''), '');
    v_payload := coalesce(v_op->'payload', v_op - 'op_id' - 'op_type' - 'type');

    if v_op_id is null then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'index', i, 'reason', 'missing_op_id'
      ));
      continue;
    end if;

    if exists (
      select 1 from public.schedule_ops so where so.op_id = v_op_id
    ) then
      applied := applied || jsonb_build_array(jsonb_build_object(
        'op_id', v_op_id, 'op_type', v_op_type, 'duplicate', true
      ));
      continue;
    end if;

    if v_op_type = 'add_slot' then
      rest_id := v_payload->>'restaurant_id';
      role_t := v_payload->>'role';
      slot_k := coalesce(nullif(v_payload->>'slot_key', '')::uuid, gen_random_uuid());
      sort_n := coalesce((v_payload->>'sort_order')::int, 0);
      if rest_id is null or role_t is null then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', v_op_id, 'reason', 'invalid_add_slot'
        ));
        continue;
      end if;
      next_rev := next_rev + 1;
      insert into public.schedule_slots (
        company_id, restaurant_id, role, slot_key, sort_order, label, active, updated_at
      ) values (
        cid, rest_id, role_t, slot_k, sort_n, v_payload->>'label', true, now()
      )
      on conflict (company_id, restaurant_id, role, slot_key) do update set
        sort_order = excluded.sort_order,
        label = coalesce(excluded.label, public.schedule_slots.label),
        active = true,
        updated_at = now();

    elsif v_op_type = 'reorder_slots' then
      rest_id := v_payload->>'restaurant_id';
      role_t := v_payload->>'role';
      next_rev := next_rev + 1;
      for sort_n in 0 .. coalesce(jsonb_array_length(v_payload->'slot_keys'), 0) - 1 loop
        slot_k := nullif(v_payload->'slot_keys'->>sort_n, '')::uuid;
        if slot_k is null then continue; end if;
        update public.schedule_slots
        set sort_order = sort_n, updated_at = now()
        where company_id = cid
          and restaurant_id = rest_id
          and role = role_t
          and slot_key = slot_k;
      end loop;

    elsif v_op_type = 'deactivate_slot' then
      rest_id := v_payload->>'restaurant_id';
      role_t := v_payload->>'role';
      slot_k := nullif(v_payload->>'slot_key', '')::uuid;
      next_rev := next_rev + 1;
      update public.schedule_slots
      set active = false, updated_at = now()
      where company_id = cid and restaurant_id = rest_id and role = role_t and slot_key = slot_k;
      update public.schedule_cells
      set deleted = true, rev = next_rev, updated_at = now(), updated_by = uid, updated_by_device = p_device_id
      where company_id = cid and restaurant_id = rest_id and role = role_t and slot_key = slot_k
        and deleted = false;

    elsif v_op_type in ('set_times', 'set_day_off', 'set_worker') then
      rest_id := v_payload->>'restaurant_id';
      day_d := nullif(v_payload->>'day_iso', '')::date;
      role_t := v_payload->>'role';
      slot_k := nullif(v_payload->>'slot_key', '')::uuid;
      if rest_id is null or day_d is null or role_t is null or slot_k is null then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', v_op_id, 'reason', 'invalid_cell_key'
        ));
        continue;
      end if;

      insert into public.schedule_slots (company_id, restaurant_id, role, slot_key, sort_order, active)
      values (cid, rest_id, role_t, slot_k, coalesce((v_payload->>'sort_order')::int, 0), true)
      on conflict do nothing;

      select c.rev into cell_rev
      from public.schedule_cells c
      where c.company_id = cid and c.restaurant_id = rest_id and c.day_iso = day_d
        and c.role = role_t and c.slot_key = slot_k;

      if p_base_rev is not null and cell_rev is not null and cell_rev > p_base_rev then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', v_op_id,
          'reason', 'cell_conflict',
          'day_iso', day_d,
          'role', role_t,
          'slot_key', slot_k,
          'server_rev', cell_rev
        ));
        continue;
      end if;

      next_rev := next_rev + 1;

      insert into public.schedule_cells as c (
        company_id, restaurant_id, day_iso, role, slot_key,
        start_hhmm, end_hhmm, worker_id, worker_name,
        break_annotation, break_paid, deleted, rev,
        updated_at, updated_by, updated_by_device
      ) values (
        cid, rest_id, day_d, role_t, slot_k,
        case when v_op_type = 'set_day_off' then null else coalesce(v_payload->>'start_hhmm', null) end,
        case when v_op_type = 'set_day_off' then null else coalesce(v_payload->>'end_hhmm', null) end,
        nullif(v_payload->>'worker_id', '')::uuid,
        nullif(v_payload->>'worker_name', ''),
        v_payload->>'break_annotation',
        case when v_payload ? 'break_paid' then (v_payload->>'break_paid')::boolean else null end,
        false,
        next_rev,
        now(), uid, p_device_id
      )
      on conflict (company_id, restaurant_id, day_iso, role, slot_key) do update set
        start_hhmm = case
          when v_op_type = 'set_day_off' then null
          when v_op_type = 'set_times' then excluded.start_hhmm
          else c.start_hhmm
        end,
        end_hhmm = case
          when v_op_type = 'set_day_off' then null
          when v_op_type = 'set_times' then excluded.end_hhmm
          else c.end_hhmm
        end,
        worker_id = case
          when v_op_type = 'set_worker' then excluded.worker_id
          else coalesce(c.worker_id, excluded.worker_id)
        end,
        worker_name = case
          when v_op_type = 'set_worker' then excluded.worker_name
          when v_op_type = 'set_day_off' then coalesce(c.worker_name, excluded.worker_name)
          else coalesce(excluded.worker_name, c.worker_name)
        end,
        break_annotation = case
          when v_op_type = 'set_day_off' then null
          when v_op_type = 'set_times' then coalesce(excluded.break_annotation, c.break_annotation)
          else c.break_annotation
        end,
        break_paid = case
          when v_op_type = 'set_times' and v_payload ? 'break_paid' then excluded.break_paid
          when v_op_type = 'set_day_off' then null
          else c.break_paid
        end,
        deleted = false,
        rev = excluded.rev,
        updated_at = now(),
        updated_by = uid,
        updated_by_device = p_device_id;

    elsif v_op_type = 'set_week_meta' then
      rest_id := v_payload->>'restaurant_id';
      week_mon := nullif(v_payload->>'week_monday_iso', '')::date;
      next_rev := next_rev + 1;
      insert into public.schedule_week_meta (
        company_id, restaurant_id, week_monday_iso,
        group_order_potential, net_sales, extras, rev, updated_at, updated_by
      ) values (
        cid, rest_id, week_mon,
        nullif(v_payload->>'group_order_potential', '')::numeric,
        nullif(v_payload->>'net_sales', '')::numeric,
        coalesce(v_payload->'extras', '{}'::jsonb),
        next_rev, now(), uid
      )
      on conflict (company_id, restaurant_id, week_monday_iso) do update set
        group_order_potential = coalesce(excluded.group_order_potential, public.schedule_week_meta.group_order_potential),
        net_sales = coalesce(excluded.net_sales, public.schedule_week_meta.net_sales),
        extras = public.schedule_week_meta.extras || excluded.extras,
        rev = excluded.rev,
        updated_at = now(),
        updated_by = uid;

    elsif v_op_type = 'publish_week' then
      rest_id := v_payload->>'restaurant_id';
      week_mon := nullif(v_payload->>'week_monday_iso', '')::date;
      next_rev := next_rev + 1;
      select coalesce(jsonb_agg(to_jsonb(c) order by c.day_iso, c.role, c.slot_key), '[]'::jsonb)
      into snap
      from public.schedule_cells c
      where c.company_id = cid
        and c.restaurant_id = rest_id
        and c.deleted = false
        and c.day_iso >= week_mon
        and c.day_iso < (week_mon + 7);
      insert into public.schedule_published_weeks (
        company_id, restaurant_id, week_monday_iso, snapshot_json, published_at, published_by, rev
      ) values (
        cid, rest_id, week_mon, jsonb_build_object('cells', snap, 'week_monday_iso', week_mon),
        now(), uid, next_rev
      )
      on conflict (company_id, restaurant_id, week_monday_iso) do update set
        snapshot_json = excluded.snapshot_json,
        published_at = now(),
        published_by = uid,
        rev = excluded.rev;

    else
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'op_id', v_op_id, 'reason', 'unknown_op_type', 'op_type', v_op_type
      ));
      continue;
    end if;

    insert into public.schedule_ops (op_id, company_id, rev, created_by, device_id, op_type, payload)
    values (v_op_id, cid, next_rev, uid, p_device_id, v_op_type, v_payload);

    applied := applied || jsonb_build_array(jsonb_build_object(
      'op_id', v_op_id, 'op_type', v_op_type, 'rev', next_rev
    ));
  end loop;

  update public.schedule_company_state
  set schedule_rev = next_rev, updated_at = now()
  where company_id = cid;

  if jsonb_array_length(applied) > 0 then
    insert into public.schedule_revisions (company_id, rev, created_by, device_id, op_summary, source)
    values (cid, next_rev, uid, p_device_id, applied, 'ops');
  end if;

  return jsonb_build_object(
    'ok', true,
    'schedule_rev', next_rev,
    'applied', applied,
    'conflicts', conflicts
  );
end;
$$;

revoke all on function public.apply_schedule_ops(jsonb, bigint, text) from public;
grant execute on function public.apply_schedule_ops(jsonb, bigint, text) to authenticated;
grant execute on function public.apply_schedule_ops(jsonb, bigint, text) to service_role;
