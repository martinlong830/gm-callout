# Supabase (single store)

This app can talk to **Supabase** for Postgres + Auth while you migrate off `localStorage`. One project = one restaurant team for now.

## 1. Create a Supabase project

1. [supabase.com](https://supabase.com) → New project → choose region/password.
2. **Project Settings → API**
   - **Project URL** → `SUPABASE_URL`
   - **anon public** key → `SUPABASE_ANON_KEY` (safe in the browser with RLS enabled)

## 2. Run the database migrations (two files, in order)

In **SQL Editor** → New query, run **each** file once, in this order:

1. `supabase/migrations/20260502120000_init_single_store.sql` — `profiles`, `staff_requests`, RLS, triggers  
2. `supabase/migrations/20260503140000_employees_table.sql` — `employees` roster table + RLS  
3. `supabase/migrations/20260504120000_team_state.sql` — `team_state` single row (`main`): schedule assignments, templates, draft matrix, messaging template text, current restaurant id  
4. `supabase/migrations/20260504130000_team_state_callout_history.sql` — adds **`callout_history`** JSON array on `team_state` (coverage outreach log from Schedule)  
5. `supabase/migrations/20260504140000_employee_chat_store.sql` — **`employee_chat_store`**: one row per auth user (`payload` = Messages threads JSON)  

Or use the [Supabase CLI](https://supabase.com/docs/guides/cli): `supabase db push` after linking the project.

**`relation "profiles" already exists`:** The first file was already applied. Do **not** re-run it. In **Table Editor**, if `staff_requests` is present you are fine; only run the **`employees`** migration file next (or skip it too if `employees` already exists).

## 3. Auth settings

- **Authentication → Providers**: enable **Email** (password or magic link — your choice).
- **Authentication → URL configuration**: add your local and production site URLs to **Redirect URLs** if you use email links or OAuth later.

**Employee sign-up from the app:** If **Confirm email** is required (Auth → Providers → Email), new employees get a confirmation link first; after they confirm, they sign in with **email + password** on the main screen. For local testing you can turn confirmation off so they get a session immediately after **Create employee account**.

**Manager sign-up (“Create manager account”):** With `SUPABASE_*` set and the app served via `npm start`, new managers use **Supabase `signUp`** (access code still **`redpoke`** in the form). Without cloud env vars, managers are still added only to **localStorage** (`gmCalloutRegisterManagerAccount`).

## 4. First manager account

1. **Authentication → Users** → Add user (email + password), or sign up from the app once login is wired.
2. In **SQL Editor**, promote that user (replace the UUID with the user id from the Auth users table):

```sql
update public.profiles
set role = 'manager'
where id = 'PASTE-YOUR-USER-UUID-HERE';
```

The web app already uses Supabase Auth when `SUPABASE_*` is set (see §5); promoting a user is how you get a **manager** if you created the user manually.

## 5. Environment variables (Node server)

In `.env` (see `env.example`):

```bash
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

Restart `npm start`. The server exposes:

- `GET /gm-supabase-config.js` — sets `window.__GM_SUPABASE_URL__` and `window.__GM_SUPABASE_ANON_KEY__`
- `GET /vendor/supabase-js.js` — Supabase browser bundle from `node_modules`

The static `index.html` loads these before `app.js`. If the env vars are missing, the app behaves as before (local demo only).

## 6. Baby steps (verify cloud data end to end)

Do these in order; stop if any step fails and fix that before moving on.

1. **Migrations** — All SQL files from §2 ran without errors (`profiles`, `staff_requests`, `employees`, `team_state` + **`callout_history`**, **`employee_chat_store`** in **Table Editor**).
2. **Env + server** — `.env` has `SUPABASE_URL` and `SUPABASE_ANON_KEY`; `npm start`; open the app; in the browser console, `window.gmSupabaseEnabled` should be **`true`**.
3. **Manager** — Sign up or sign in as manager (email path). If **`employees`** is still empty, refresh once after login: the app **upserts the in-memory roster** (including demo seed) the first time a manager hydrates against an empty table. You can always change the roster in **Staff** and save; that also upserts all rows.
4. **Employee** — Register or sign in as employee; confirm a row in **`employees`** with **`auth_user_id`** set when they register while signed in.
5. **Staff request** — From the employee shell, submit one action (e.g. time off). Confirm a row in **`staff_requests`** with **`requester_id`** = that user and **`payload`** JSON populated.
6. **Manager approval** — As manager, approve or decline that request; **`staff_requests.status`** should become `approved` or `rejected`.
7. **`team_state`** (after running migration 3) — As **manager**, change a shift assignment or draft schedule, wait ~1s, refresh **Table Editor → `team_state`**: `schedule_assignments` / `draft_schedule` JSON should update. As **employee**, sign in on another browser (or after clearing local schedule keys): schedule should match what the manager pushed.

8. **Callout history** — After migration 4: as **manager**, start a coverage callout (or confirm replacement). **`team_state.callout_history`** should gain entries (~700ms debounce). As **employee**, open **Actions → Call-outs** and confirm the same outreach rows appear after refresh / re-login.

9. **Messages (employee + manager)** — After migration 5: sign in as **employee**, open **Messages**, send a line. **`employee_chat_store`** should have a row for your `user_id` with updated **`payload`** (~700ms debounce). Sign in as **manager**, open the **Messages** tab (same UI pattern), send a line: a second row (or the same user if you share one account) updates **`employee_chat_store`** for that manager’s `user_id`. Second device or browser: same login should show the same threads after refresh.

Still local-only: legacy **portal password** accounts (non–Supabase Auth demo).

## Security notes

- **Never** put the **service role** key in the web or mobile app.
- RLS policies in the migration assume **one team per project**. When you add multiple stores, introduce `store_id` on rows and tighten policies.
