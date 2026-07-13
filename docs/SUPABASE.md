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
6. `supabase/migrations/20260504150000_employee_chat_store_realtime.sql` — Realtime on `employee_chat_store`  
7. `supabase/migrations/20260516120000_timeclock.sql` — **`timeclock`** profile role, `employees.clock_pin`, `time_clock_entries`, punch RPCs  
8. Later multi-tenant: `20260702180000_companies_multi_tenant.sql`, companies RLS oneshots, and **`20260713010000_employees_company_id.sql`** (or paste `fix-employees-company-id-oneshot.sql`) so each company only sees its own roster. 

Or use the [Supabase CLI](https://supabase.com/docs/guides/cli): `supabase db push` after linking the project.

If your hosted project **already has** time-clock tables from a previous laptop, compare names/columns with migration `20260516120000_timeclock.sql`. Skip or adjust the migration if they match.

**`relation "profiles" already exists`:** The first file was already applied. Do **not** re-run it. In **Table Editor**, if `staff_requests` is present you are fine; only run the **`employees`** migration file next (or skip it too if `employees` already exists).

## 3. Auth settings

- **Authentication → Providers**: enable **Email** (password or magic link — your choice).

### Production URL configuration (required for create-company confirm links)

Company confirmation emails use Supabase `generateLink` with
`redirectTo=https://shiflow.app/?setup_access_code=1`. If **Site URL** is still
`http://localhost:3000`, or the redirect is not allow-listed, Supabase rewrites
`redirect_to` to localhost and users land on the wrong host after confirm.

In **Supabase Dashboard → Authentication → URL Configuration**, set:

| Setting | Value |
| --- | --- |
| **Site URL** | `https://shiflow.app` |
| **Redirect URLs** (allow list) | `https://shiflow.app/**` |
| | `https://shiflow.app/?setup_access_code=1` |
| | `http://localhost:8000/**` (local dev only) |

Remove any leftover `http://localhost:3000` Site URL / redirect entries unless you
still develop against that port.

### Sender display name (Gmail “From”)

Create-company and password-reset emails are sent by **Resend** from the Node
server (`portal-email.js`), **not** by Supabase’s built-in Auth templates.

On **Render** (and local `.env`), set:

```bash
PASSWORD_RESET_FROM_EMAIL=Shiflow <noreply@shiflow.app>
PUBLIC_BASE_URL=https://shiflow.app
SITE_URL=https://shiflow.app
```

Gmail shows the display name from the text before `<noreply@shiflow.app>`. Use
**Shiflow**, not “Red Poke Schedule” / “Red Poke Scheduler”.

If you also send mail through **Supabase Auth → SMTP / Email templates** (e.g.
built-in confirm/reset), set the SMTP **Sender name** to **Shiflow** there too.
This app’s create-company flow does not rely on those templates when Resend is
configured.

**Employee sign-up from the app:** If **Confirm email** is required (Auth → Providers → Email), new employees get a confirmation link first; after they confirm, they sign in with **email + password** on the main screen. For local testing you can turn confirmation off so they get a session immediately after **Create employee account**.

**Manager sign-up (“Create manager account”):** With `SUPABASE_*` set and the app served via `npm start`, new managers use **Supabase `signUp`** (access code still **`redpoke`** in the form). Without cloud env vars, managers are still added only to **localStorage** (`gmCalloutRegisterManagerAccount`).

**Time clock device (“Time clock device sign in”):** Register with access code **`redpoke`**, **device name**, and password (no email in the UI). The Node server creates the auth user with a hidden internal address. Requires **`SUPABASE_SERVICE_ROLE_KEY`** in `.env` (server only). Run migration `20260517120000_portal_login_names.sql`. Staff punch in/out with a **6-digit PIN** on each `employees` row.

**All portal accounts (manager / employee / time clock):** Sign-in and sign-up use **name + password** via `POST /api/portal/signin` and `/api/portal/signup`. Add `SUPABASE_SERVICE_ROLE_KEY` from Project Settings → API → `service_role` to `.env`, restart `npm start`.

**Forgot password / create company confirm:** On the login screen, **Forgot password?** emails a reset link; **Create company** emails a confirm link that should open **`https://shiflow.app/?setup_access_code=1`**. Requires:

1. Migration `20260531120000_password_reset.sql` (password reset)
2. `PUBLIC_BASE_URL` / `SITE_URL` = `https://shiflow.app` on Render (never `http://localhost:3000`)
3. `RESEND_API_KEY` and `PASSWORD_RESET_FROM_EMAIL=Shiflow <noreply@shiflow.app>`
4. Supabase Site URL + Redirect URLs as in the table above

Existing accounts: each person sets their own recovery email after sign-in via **Account** (top right). New sign-ups enter it on the create-account form.

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
3. **Manager** — Sign up or sign in as manager (email path). **Red Poke** only: if **`employees`** is still empty, refresh once after login and the app may upsert the in-memory demo roster. **Other companies** start with an empty Team (no Red Poke seed). You can always add staff in **Team** and save.
4. **Employee** — Register or sign in as employee; confirm a row in **`employees`** with **`auth_user_id`** set when they register while signed in.
5. **Staff request** — From the employee shell, submit one action (e.g. time off). Confirm a row in **`staff_requests`** with **`requester_id`** = that user and **`payload`** JSON populated.
6. **Manager approval** — As manager, approve or decline that request; **`staff_requests.status`** should become `approved` or `rejected`.
7. **`team_state`** (after running migration 3) — As **manager**, change a shift assignment or draft schedule, wait ~1s, refresh **Table Editor → `team_state`**: `schedule_assignments` / `draft_schedule` JSON should update. As **employee**, sign in on another browser (or after clearing local schedule keys): schedule should match what the manager pushed.

8. **Callout history** — After migration 4: as **manager**, start a coverage callout (or confirm replacement). **`team_state.callout_history`** should gain entries (~700ms debounce). As **employee**, open **Actions → Call-outs** and confirm the same outreach rows appear after refresh / re-login.

9. **Messages (employee + manager)** — After migration 5: sign in as **employee**, open **Messages**, send a line. **`employee_chat_store`** should have a row for your `user_id` with updated **`payload`** (~700ms debounce). Sign in as **manager**, open the **Messages** tab (same UI pattern), send a line: a second row (or the same user if you share one account) updates **`employee_chat_store`** for that manager’s `user_id`. Second device or browser: same login should show the same threads after refresh.

Still local-only: legacy **portal password** accounts (non–Supabase Auth demo).

## Security notes

- **Never** put the **service role** key in the web or mobile app.
- Roster rows are scoped by **`employees.company_id`** (migration `20260713010000_employees_company_id.sql` / oneshot `fix-employees-company-id-oneshot.sql`). New companies must not see Red Poke staff.
