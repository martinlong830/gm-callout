# gm-callout (Red Poke Scheduler)

- **Web / server:** from this folder, `npm start` (see `docs/SUPABASE.md` for env).
- **Mobile (Expo):** lives in **`mobile/`**. From this same folder run:
  - `npm run mobile` — Expo dev server (LAN QR).
  - `npm run mobile:tunnel` — if the QR code does not open on your phone.
- Copy **`mobile/.env.example`** → **`mobile/.env`** and set `EXPO_PUBLIC_SUPABASE_*` there (or reuse the same URL/anon key as the web `.env`).

Details and migration status: **`mobile/README.md`**. The app uses **Expo Router** (`/login`, `/employee`, `/manager`).
