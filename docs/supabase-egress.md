# Supabase egress control

The app previously burned bandwidth mainly by re-downloading multi-MB `team_state` JSON
(schedule assignments, drafts, tip payroll history) on every Realtime ping, tab focus,
and mobile foreground — multiplied by web + mobile clients and multiple open tabs.

## Required dashboard / migration steps (do these first)

1. **Apply migration** `supabase/migrations/20260709180000_team_state_realtime_egress.sql`
   - Supabase Dashboard → **SQL Editor** → paste/run the file, **or**
   - `supabase db push` from this repo if the CLI is linked to the project.
2. **Confirm `team_state` is off Realtime replication**
   - Dashboard → **Database** → **Publications** → `supabase_realtime`
   - `public.team_state` must **not** be listed.
   - Or run:

```sql
select tablename
from pg_publication_tables
where pubname = 'supabase_realtime'
order by tablename;
```

   Expect `employees`, `staff_requests`, `time_clock_entries`, `employee_chat_store` (as needed)
   — **not** `team_state`.

3. **Break down egress by product** (Dashboard → **Reports** / **Usage**)
   - **Realtime** — full-row `postgres_changes` still emits entire NEW rows for subscribed tables.
   - **Database / API** — REST `select` of large JSON (this was the main multi-GB risk).
   - **Storage** — employee photo CDN downloads (usually smaller than team_state JSON).

4. **Deploy the client changes** in this PR (web + mobile). Old clients will keep
   fetching full rows until users refresh / update the app.

## What the clients now do

| Area | Change | Est. impact |
|---|---|---|
| Mobile Broadcast handler | Selective column fetch + `updated_at` probe; no full hydrate | **Very high** (was the #1 leak) |
| Mobile foreground | Pause Realtime while backgrounded; cheap `updated_at` skip | High |
| Web/mobile bootstrap | Explicit columns — never `team_state.select('*')` | High on login/reload |
| Web remote refresh | Skip download when `updated_at` unchanged | High on focus/broadcast |
| Debounces | Push 3s, remote refresh 1.2s, tip payroll 4s, schedule 3s | Medium |
| Photos (mobile) | One remote JPG candidate; prefer bundled | Medium on roster |
| Timecards punches | 45s week-cache freshness before Realtime refetch | Medium while on Timecards |

## How to verify egress drops

1. After deploying, open Dashboard → **Project Settings → Usage** (or Billing → Egress).
2. Watch **Database egress** over 24–48h of normal manager schedule editing + mobile use.
   Expect a sharp drop vs the period that hit ~14 GB.
3. Local smoke checks while editing schedule:
   - Browser Network tab: Broadcast payloads ~100 bytes; REST `team_state` selects
     only dirty columns (or skipped after `updated_at` probe).
   - Hidden tab: Realtime channels tear down; no repeated multi-MB downloads.
4. Optional SQL: measure row size once:

```sql
select id,
  pg_column_size(schedule_assignments) as assign_bytes,
  pg_column_size(draft_schedule) as draft_bytes,
  pg_column_size(timecard_week_tip_pool) as tip_bytes,
  pg_column_size(timecard_week_extras) as extras_bytes
from public.team_state;
```

If any column is multiple MB, every accidental `select('*')` costs that much per client.

## Remaining risks (follow-ups)

- `employees` / `time_clock_entries` / `staff_requests` still use full-row Realtime
  `postgres_changes` (smaller than team_state, but not free).
- Tip payroll still read-merges historical JSON blobs (debounce raised; normalize weeks later).
- Multiple browser tabs / Expo hot reload still multiply traffic — close unused tabs in prod.
