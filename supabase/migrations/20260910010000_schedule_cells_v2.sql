-- Schedule sync v2: date-keyed cells, schedule-only revision clock, op log, published snapshots.
-- Safe to re-run. Does not remove team_state schedule blobs (dual-write / projection era).

-- ---------------------------------------------------------------------------
-- Company schedule clock (separate from tip/payroll team_state.updated_at)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_company_state (
  company_id uuid primary key references public.companies (id) on delete cascade,
  schedule_rev bigint not null default 0,
  updated_at timestamptz not null default now()
);

comment on table public.schedule_company_state is
  'Monotonic schedule_rev per company. Tip/payroll must never bump this.';

-- ---------------------------------------------------------------------------
-- Stable person-row identity (survives reorder; not trIdx)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_slots (
  company_id uuid not null references public.companies (id) on delete cascade,
  restaurant_id text not null,
  role text not null check (role in ('Bartender', 'Kitchen', 'Server')),
  slot_key uuid not null default gen_random_uuid(),
  sort_order integer not null default 0,
  label text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (company_id, restaurant_id, role, slot_key)
);

create index if not exists schedule_slots_company_rest_role_order_idx
  on public.schedule_slots (company_id, restaurant_id, role, sort_order)
  where active;

-- ---------------------------------------------------------------------------
-- One cell = one slot on one calendar day (ISO date keys — never rolling indices)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_cells (
  company_id uuid not null references public.companies (id) on delete cascade,
  restaurant_id text not null,
  day_iso date not null,
  role text not null check (role in ('Bartender', 'Kitchen', 'Server')),
  slot_key uuid not null,
  start_hhmm text,
  end_hhmm text,
  worker_id uuid,
  worker_name text,
  break_annotation text,
  break_paid boolean,
  deleted boolean not null default false,
  rev bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  updated_by_device text,
  primary key (company_id, restaurant_id, day_iso, role, slot_key),
  constraint schedule_cells_slot_fk
    foreign key (company_id, restaurant_id, role, slot_key)
    references public.schedule_slots (company_id, restaurant_id, role, slot_key)
    on delete cascade
);

create index if not exists schedule_cells_company_day_idx
  on public.schedule_cells (company_id, day_iso)
  where deleted = false;

create index if not exists schedule_cells_company_rev_idx
  on public.schedule_cells (company_id, rev desc);

create index if not exists schedule_cells_company_rest_week_idx
  on public.schedule_cells (company_id, restaurant_id, day_iso);

-- ---------------------------------------------------------------------------
-- Week meta (net sales / group order) — not inside cell blobs
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_week_meta (
  company_id uuid not null references public.companies (id) on delete cascade,
  restaurant_id text not null,
  week_monday_iso date not null,
  group_order_potential numeric,
  net_sales numeric,
  extras jsonb not null default '{}'::jsonb,
  rev bigint not null default 0,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null,
  primary key (company_id, restaurant_id, week_monday_iso)
);

-- ---------------------------------------------------------------------------
-- Immutable published snapshots (employees read only these)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_published_weeks (
  company_id uuid not null references public.companies (id) on delete cascade,
  restaurant_id text not null,
  week_monday_iso date not null,
  snapshot_json jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default now(),
  published_by uuid references auth.users (id) on delete set null,
  rev bigint not null default 0,
  primary key (company_id, restaurant_id, week_monday_iso)
);

-- ---------------------------------------------------------------------------
-- Audit / History (cell-era)
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_revisions (
  id uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies (id) on delete cascade,
  rev bigint not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  device_id text,
  op_summary jsonb not null default '[]'::jsonb,
  source text not null default 'ops'
    check (source in ('ops', 'publish', 'backfill', 'hard_revert', 'manual'))
);

create index if not exists schedule_revisions_company_rev_idx
  on public.schedule_revisions (company_id, rev desc);

-- ---------------------------------------------------------------------------
-- Idempotent op log
-- ---------------------------------------------------------------------------
create table if not exists public.schedule_ops (
  op_id uuid primary key,
  company_id uuid not null references public.companies (id) on delete cascade,
  rev bigint not null,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  device_id text,
  op_type text not null,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists schedule_ops_company_rev_idx
  on public.schedule_ops (company_id, rev desc);

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.schedule_company_state enable row level security;
alter table public.schedule_slots enable row level security;
alter table public.schedule_cells enable row level security;
alter table public.schedule_week_meta enable row level security;
alter table public.schedule_published_weeks enable row level security;
alter table public.schedule_revisions enable row level security;
alter table public.schedule_ops enable row level security;

create or replace function public.profile_in_company(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select cid is not null and exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.company_id = cid
  );
$$;

revoke all on function public.profile_in_company(uuid) from public;
grant execute on function public.profile_in_company(uuid) to authenticated;
grant execute on function public.profile_in_company(uuid) to service_role;

-- SELECT: any company member
drop policy if exists schedule_company_state_select on public.schedule_company_state;
create policy schedule_company_state_select on public.schedule_company_state
  for select to authenticated
  using (public.profile_in_company(company_id));

drop policy if exists schedule_slots_select on public.schedule_slots;
create policy schedule_slots_select on public.schedule_slots
  for select to authenticated
  using (public.profile_in_company(company_id));

drop policy if exists schedule_cells_select on public.schedule_cells;
create policy schedule_cells_select on public.schedule_cells
  for select to authenticated
  using (public.profile_in_company(company_id));

drop policy if exists schedule_week_meta_select on public.schedule_week_meta;
create policy schedule_week_meta_select on public.schedule_week_meta
  for select to authenticated
  using (public.profile_in_company(company_id));

drop policy if exists schedule_published_weeks_select on public.schedule_published_weeks;
create policy schedule_published_weeks_select on public.schedule_published_weeks
  for select to authenticated
  using (public.profile_in_company(company_id));

drop policy if exists schedule_revisions_select on public.schedule_revisions;
create policy schedule_revisions_select on public.schedule_revisions
  for select to authenticated
  using (public.profile_in_company(company_id) and public.is_manager(auth.uid()));

drop policy if exists schedule_ops_select on public.schedule_ops;
create policy schedule_ops_select on public.schedule_ops
  for select to authenticated
  using (public.profile_in_company(company_id) and public.is_manager(auth.uid()));

-- Direct client writes disabled — all mutations go through apply_schedule_ops (security definer).
-- service_role bypasses RLS for backfill jobs.

grant select on public.schedule_company_state to authenticated;
grant select on public.schedule_slots to authenticated;
grant select on public.schedule_cells to authenticated;
grant select on public.schedule_week_meta to authenticated;
grant select on public.schedule_published_weeks to authenticated;
grant select on public.schedule_revisions to authenticated;
grant select on public.schedule_ops to authenticated;

grant select, insert, update, delete on public.schedule_company_state to service_role;
grant select, insert, update, delete on public.schedule_slots to service_role;
grant select, insert, update, delete on public.schedule_cells to service_role;
grant select, insert, update, delete on public.schedule_week_meta to service_role;
grant select, insert, update, delete on public.schedule_published_weeks to service_role;
grant select, insert, update, delete on public.schedule_revisions to service_role;
grant select, insert, update, delete on public.schedule_ops to service_role;

-- Realtime for live cell sync
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_cells'
  ) then
    alter publication supabase_realtime add table public.schedule_cells;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_slots'
  ) then
    alter publication supabase_realtime add table public.schedule_slots;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'schedule_company_state'
  ) then
    alter publication supabase_realtime add table public.schedule_company_state;
  end if;
exception when others then
  raise notice 'schedule v2 realtime publication: %', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- apply_schedule_ops — server authority; LWW by schedule_rev; idempotent op_id
-- ---------------------------------------------------------------------------
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
  op jsonb;
  op_id uuid;
  op_type text;
  payload jsonb;
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

  -- Lock company clock for the batch
  select schedule_rev into next_rev
  from public.schedule_company_state
  where company_id = cid
  for update;

  next_rev := coalesce(next_rev, 0);

  n := jsonb_array_length(p_ops);
  for i in 0 .. n - 1 loop
    op := p_ops -> i;
    op_id := nullif(op->>'op_id', '')::uuid;
    op_type := coalesce(nullif(op->>'op_type', ''), nullif(op->>'type', ''), '');
    payload := coalesce(op->'payload', op - 'op_id' - 'op_type' - 'type');

    if op_id is null then
      conflicts := conflicts || jsonb_build_array(jsonb_build_object(
        'index', i, 'reason', 'missing_op_id'
      ));
      continue;
    end if;

    -- Idempotent: already applied
    if exists (select 1 from public.schedule_ops where schedule_ops.op_id = op_id) then
      applied := applied || jsonb_build_array(jsonb_build_object(
        'op_id', op_id, 'op_type', op_type, 'duplicate', true
      ));
      continue;
    end if;

    if op_type = 'add_slot' then
      rest_id := payload->>'restaurant_id';
      role_t := payload->>'role';
      slot_k := coalesce(nullif(payload->>'slot_key', '')::uuid, gen_random_uuid());
      sort_n := coalesce((payload->>'sort_order')::int, 0);
      if rest_id is null or role_t is null then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', op_id, 'reason', 'invalid_add_slot'
        ));
        continue;
      end if;
      next_rev := next_rev + 1;
      insert into public.schedule_slots (
        company_id, restaurant_id, role, slot_key, sort_order, label, active, updated_at
      ) values (
        cid, rest_id, role_t, slot_k, sort_n, payload->>'label', true, now()
      )
      on conflict (company_id, restaurant_id, role, slot_key) do update set
        sort_order = excluded.sort_order,
        label = coalesce(excluded.label, public.schedule_slots.label),
        active = true,
        updated_at = now();

    elsif op_type = 'reorder_slots' then
      rest_id := payload->>'restaurant_id';
      role_t := payload->>'role';
      next_rev := next_rev + 1;
      for sort_n in 0 .. coalesce(jsonb_array_length(payload->'slot_keys'), 0) - 1 loop
        slot_k := nullif(payload->'slot_keys'->>sort_n, '')::uuid;
        if slot_k is null then continue; end if;
        update public.schedule_slots
        set sort_order = sort_n, updated_at = now()
        where company_id = cid
          and restaurant_id = rest_id
          and role = role_t
          and slot_key = slot_k;
      end loop;

    elsif op_type = 'deactivate_slot' then
      rest_id := payload->>'restaurant_id';
      role_t := payload->>'role';
      slot_k := nullif(payload->>'slot_key', '')::uuid;
      next_rev := next_rev + 1;
      update public.schedule_slots
      set active = false, updated_at = now()
      where company_id = cid and restaurant_id = rest_id and role = role_t and slot_key = slot_k;
      update public.schedule_cells
      set deleted = true, rev = next_rev, updated_at = now(), updated_by = uid, updated_by_device = p_device_id
      where company_id = cid and restaurant_id = rest_id and role = role_t and slot_key = slot_k
        and deleted = false;

    elsif op_type in ('set_times', 'set_day_off', 'set_worker') then
      rest_id := payload->>'restaurant_id';
      day_d := nullif(payload->>'day_iso', '')::date;
      role_t := payload->>'role';
      slot_k := nullif(payload->>'slot_key', '')::uuid;
      if rest_id is null or day_d is null or role_t is null or slot_k is null then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', op_id, 'reason', 'invalid_cell_key'
        ));
        continue;
      end if;

      -- Ensure slot exists
      insert into public.schedule_slots (company_id, restaurant_id, role, slot_key, sort_order, active)
      values (cid, rest_id, role_t, slot_k, coalesce((payload->>'sort_order')::int, 0), true)
      on conflict do nothing;

      select rev into cell_rev
      from public.schedule_cells
      where company_id = cid and restaurant_id = rest_id and day_iso = day_d
        and role = role_t and slot_key = slot_k;

      if p_base_rev is not null and cell_rev is not null and cell_rev > p_base_rev then
        conflicts := conflicts || jsonb_build_array(jsonb_build_object(
          'op_id', op_id,
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
        case when op_type = 'set_day_off' then null else coalesce(payload->>'start_hhmm', null) end,
        case when op_type = 'set_day_off' then null else coalesce(payload->>'end_hhmm', null) end,
        nullif(payload->>'worker_id', '')::uuid,
        nullif(payload->>'worker_name', ''),
        payload->>'break_annotation',
        case when payload ? 'break_paid' then (payload->>'break_paid')::boolean else null end,
        false,
        next_rev,
        now(), uid, p_device_id
      )
      on conflict (company_id, restaurant_id, day_iso, role, slot_key) do update set
        start_hhmm = case
          when op_type = 'set_day_off' then null
          when op_type = 'set_times' then excluded.start_hhmm
          else c.start_hhmm
        end,
        end_hhmm = case
          when op_type = 'set_day_off' then null
          when op_type = 'set_times' then excluded.end_hhmm
          else c.end_hhmm
        end,
        -- Day-off keeps worker/row owner unless set_worker clears/sets it
        worker_id = case
          when op_type = 'set_worker' then excluded.worker_id
          else coalesce(c.worker_id, excluded.worker_id)
        end,
        worker_name = case
          when op_type = 'set_worker' then excluded.worker_name
          when op_type = 'set_day_off' then coalesce(c.worker_name, excluded.worker_name)
          else coalesce(excluded.worker_name, c.worker_name)
        end,
        break_annotation = case
          when op_type = 'set_day_off' then null
          when op_type = 'set_times' then coalesce(excluded.break_annotation, c.break_annotation)
          else c.break_annotation
        end,
        break_paid = case
          when op_type = 'set_times' and payload ? 'break_paid' then excluded.break_paid
          when op_type = 'set_day_off' then null
          else c.break_paid
        end,
        deleted = false,
        rev = excluded.rev,
        updated_at = now(),
        updated_by = uid,
        updated_by_device = p_device_id;

    elsif op_type = 'set_week_meta' then
      rest_id := payload->>'restaurant_id';
      week_mon := nullif(payload->>'week_monday_iso', '')::date;
      next_rev := next_rev + 1;
      insert into public.schedule_week_meta (
        company_id, restaurant_id, week_monday_iso,
        group_order_potential, net_sales, extras, rev, updated_at, updated_by
      ) values (
        cid, rest_id, week_mon,
        nullif(payload->>'group_order_potential', '')::numeric,
        nullif(payload->>'net_sales', '')::numeric,
        coalesce(payload->'extras', '{}'::jsonb),
        next_rev, now(), uid
      )
      on conflict (company_id, restaurant_id, week_monday_iso) do update set
        group_order_potential = coalesce(excluded.group_order_potential, public.schedule_week_meta.group_order_potential),
        net_sales = coalesce(excluded.net_sales, public.schedule_week_meta.net_sales),
        extras = public.schedule_week_meta.extras || excluded.extras,
        rev = excluded.rev,
        updated_at = now(),
        updated_by = uid;

    elsif op_type = 'publish_week' then
      rest_id := payload->>'restaurant_id';
      week_mon := nullif(payload->>'week_monday_iso', '')::date;
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
        'op_id', op_id, 'reason', 'unknown_op_type', 'op_type', op_type
      ));
      continue;
    end if;

    insert into public.schedule_ops (op_id, company_id, rev, created_by, device_id, op_type, payload)
    values (op_id, cid, next_rev, uid, p_device_id, op_type, payload);

    applied := applied || jsonb_build_array(jsonb_build_object(
      'op_id', op_id, 'op_type', op_type, 'rev', next_rev
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

-- ---------------------------------------------------------------------------
-- Backfill cells from legacy team_state blobs (one company)
-- ---------------------------------------------------------------------------
create or replace function public.backfill_schedule_cells_from_team_state(p_company_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  ts_row record;
  assign jsonb;
  draft jsonb;
  by_week jsonb;
  window_mon date;
  rest_id text;
  shift_id text;
  entry jsonb;
  parts text[];
  gdi int;
  role_idx int;
  tr_idx int;
  role_t text;
  day_d date;
  slot_k uuid;
  cell_count int := 0;
  slot_count int := 0;
  roles text[] := array['Bartender', 'Kitchen', 'Server'];
  role_rows jsonb;
  row_cells jsonb;
  di int;
  cell jsonb;
  start_t text;
  end_t text;
  slot_map jsonb := '{}'::jsonb;
  map_key text;
  wi int;
  layers jsonb;
  week_blob jsonb;
  rest_keys text[];
  r_i int;
begin
  select * into ts_row
  from public.team_state
  where company_id = p_company_id
  order by case when id = 'main' then 0 else 1 end
  limit 1;

  if not found or ts_row.id is null then
    select * into ts_row from public.team_state where id = 'main' limit 1;
  end if;

  if not found or ts_row.id is null then
    return jsonb_build_object('ok', false, 'reason', 'no_team_state');
  end if;

  insert into public.schedule_company_state (company_id, schedule_rev)
  values (p_company_id, 0)
  on conflict do nothing;

  assign := coalesce(ts_row.schedule_assignments, '{}'::jsonb);
  draft := coalesce(ts_row.draft_schedule, '{}'::jsonb);
  by_week := coalesce(draft->'byWeek', '{}'::jsonb);
  begin
    window_mon := nullif(draft->>'windowMondayIso', '')::date;
  exception when others then
    window_mon := null;
  end;
  if window_mon is null then
    window_mon := date_trunc('week', timezone('UTC', now()))::date;
  end if;

  for rest_id in select jsonb_object_keys(assign) loop
    if jsonb_typeof(assign->rest_id) <> 'object' then continue; end if;
    for shift_id in select jsonb_object_keys(assign->rest_id) loop
      if shift_id not like 'shift-%' then continue; end if;
      parts := string_to_array(substr(shift_id, 7), '-');
      if array_length(parts, 1) < 3 then continue; end if;
      begin
        gdi := parts[1]::int;
        role_idx := parts[2]::int;
        tr_idx := parts[3]::int;
      exception when others then
        continue;
      end;
      if role_idx < 0 or role_idx > 2 then continue; end if;
      role_t := roles[role_idx + 1];
      day_d := (window_mon - 84) + gdi;
      map_key := rest_id || '|' || role_t || '|' || tr_idx::text;
      if slot_map ? map_key then
        slot_k := (slot_map->>map_key)::uuid;
      else
        slot_k := gen_random_uuid();
        slot_map := slot_map || jsonb_build_object(map_key, to_jsonb(slot_k::text));
        insert into public.schedule_slots (
          company_id, restaurant_id, role, slot_key, sort_order, active
        ) values (
          p_company_id, rest_id, role_t, slot_k, tr_idx, true
        )
        on conflict do nothing;
        slot_count := slot_count + 1;
      end if;

      entry := assign->rest_id->shift_id;
      insert into public.schedule_cells (
        company_id, restaurant_id, day_iso, role, slot_key,
        worker_name, break_annotation, break_paid,
        deleted, rev, updated_at
      ) values (
        p_company_id, rest_id, day_d, role_t, slot_k,
        case
          when jsonb_typeof(entry->'workers') = 'array'
            and coalesce(entry->'workers'->>0, '') not in ('', 'Unassigned')
            then entry->'workers'->>0
          else nullif(entry->>'rowOwner', '')
        end,
        entry->>'break',
        case when entry ? 'breakPaid' then (entry->>'breakPaid')::boolean else null end,
        false, 1, now()
      )
      on conflict (company_id, restaurant_id, day_iso, role, slot_key) do update set
        worker_name = coalesce(excluded.worker_name, public.schedule_cells.worker_name),
        break_annotation = coalesce(excluded.break_annotation, public.schedule_cells.break_annotation),
        break_paid = coalesce(excluded.break_paid, public.schedule_cells.break_paid),
        updated_at = now();
      cell_count := cell_count + 1;
    end loop;
  end loop;

  select coalesce(array_agg(distinct s.restaurant_id), array[]::text[])
  into rest_keys
  from public.schedule_slots s
  where s.company_id = p_company_id;

  if rest_keys is null or coalesce(array_length(rest_keys, 1), 0) = 0 then
    rest_keys := array['rp-9'];
  end if;

  for r_i in 1 .. array_length(rest_keys, 1) loop
    rest_id := rest_keys[r_i];
    for wi in 0 .. 14 loop
      week_blob := by_week->(wi::text);
      if week_blob is null then continue; end if;
      if week_blob ? rest_id then
        layers := week_blob->rest_id;
      elsif week_blob ? 'Bartender' then
        layers := week_blob;
      else
        continue;
      end if;
      for role_idx in 0 .. 2 loop
        role_t := roles[role_idx + 1];
        role_rows := layers->role_t;
        if jsonb_typeof(role_rows) <> 'array' then continue; end if;
        for tr_idx in 0 .. jsonb_array_length(role_rows) - 1 loop
          map_key := rest_id || '|' || role_t || '|' || tr_idx::text;
          if not (slot_map ? map_key) then
            slot_k := gen_random_uuid();
            slot_map := slot_map || jsonb_build_object(map_key, to_jsonb(slot_k::text));
            insert into public.schedule_slots (
              company_id, restaurant_id, role, slot_key, sort_order, active
            ) values (p_company_id, rest_id, role_t, slot_k, tr_idx, true)
            on conflict do nothing;
            slot_count := slot_count + 1;
          else
            slot_k := (slot_map->>map_key)::uuid;
          end if;
          row_cells := role_rows->tr_idx;
          if jsonb_typeof(row_cells) <> 'array' then continue; end if;
          for di in 0 .. least(jsonb_array_length(row_cells), 7) - 1 loop
            cell := row_cells->di;
            day_d := (window_mon - 84) + (wi * 7 + di);
            start_t := null;
            end_t := null;
            if jsonb_typeof(cell) = 'array' and jsonb_array_length(cell) >= 2 then
              start_t := nullif(cell->>0, '');
              end_t := nullif(cell->>1, '');
            end if;
            insert into public.schedule_cells (
              company_id, restaurant_id, day_iso, role, slot_key,
              start_hhmm, end_hhmm, deleted, rev, updated_at
            ) values (
              p_company_id, rest_id, day_d, role_t, slot_k,
              start_t, end_t, false, 1, now()
            )
            on conflict (company_id, restaurant_id, day_iso, role, slot_key) do update set
              start_hhmm = excluded.start_hhmm,
              end_hhmm = excluded.end_hhmm,
              updated_at = now();
            cell_count := cell_count + 1;
          end loop;
        end loop;
      end loop;
    end loop;
  end loop;

  update public.schedule_company_state
  set schedule_rev = greatest(schedule_rev, 1), updated_at = now()
  where company_id = p_company_id;

  insert into public.schedule_revisions (company_id, rev, op_summary, source)
  values (
    p_company_id,
    1,
    jsonb_build_array(jsonb_build_object('backfill', true, 'cells', cell_count, 'slots', slot_count)),
    'backfill'
  );

  return jsonb_build_object(
    'ok', true,
    'company_id', p_company_id,
    'cells', cell_count,
    'slots', slot_count,
    'window_monday', window_mon
  );
end;
$$;

revoke all on function public.backfill_schedule_cells_from_team_state(uuid) from public;
grant execute on function public.backfill_schedule_cells_from_team_state(uuid) to service_role;
grant execute on function public.backfill_schedule_cells_from_team_state(uuid) to authenticated;

comment on function public.apply_schedule_ops(jsonb, bigint, text) is
  'Schedule sync v2: apply idempotent ops; bumps schedule_rev only (not tip/payroll).';
comment on function public.backfill_schedule_cells_from_team_state(uuid) is
  'One-time / repair: expand team_state schedule blobs into schedule_cells with ISO dates.';
