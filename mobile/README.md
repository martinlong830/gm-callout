# Red Poke Scheduler — Expo (iOS & Android)

This is the native shell for **gm-callout**, starting from **Supabase Auth** with the same project as the web app.

## Prerequisites

- Node 18+
- [Expo Go](https://expo.dev/go) on a phone, or Xcode (iOS) / Android Studio (Android) for simulators

## Setup

1. From this `mobile` folder:

   ```bash
   cp .env.example .env
   ```

2. Fill in `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY` (same as `SUPABASE_URL` / `SUPABASE_ANON_KEY` used by `npm start` in the parent app — see `../docs/SUPABASE.md`).

3. Install and run:

   ```bash
   npm install
   npx expo start
   ```

   Then press `i` for iOS simulator, `a` for Android emulator, or open the project in **Expo Go** (see below).

From the **repo root** you can also run:

```bash
npm run mobile
```

Use tunnel mode if the QR code still fails (common on guest Wi‑Fi, VPNs, or strict routers). The project includes **`@expo/ngrok`** so `expo start --tunnel` works after `npm install`:

```bash
npm run start:tunnel
```

## QR code / “Can’t connect” on your phone

1. **Install [Expo Go](https://expo.dev/go)** from the App Store or Play Store and update it so it supports your SDK (this project uses **Expo SDK 54**).

2. **Same network (LAN mode — default `expo start`)**  
   Phone and computer must be on the **same Wi‑Fi** (not guest/captive portal if it isolates clients). Turn off **VPN** on the phone and Mac while testing.

3. **Tunnel mode (when LAN is blocked)**  
   Run `npm run start:tunnel` in `mobile/`, wait until the tunnel URL appears, then scan the new QR or tap **Enter URL manually** in Expo Go and paste the `exp://…` link from the terminal.

4. **Manual URL**  
   In Expo Go: **Projects → Enter URL manually** and paste the `exp://…` string shown under the QR code in the terminal (use the tunnel URL if LAN does not work).

5. **Firewall**  
   Allow **Node** through the macOS firewall (or temporarily disable it) so the phone can reach port **8081** on your computer.

## What’s implemented (migration in progress)

- **Expo Router** — `/` redirects by auth; **`/login`**, **`/employee`** (tabs), **`/manager`** (tabs).
- **Auth** — same flow as web: `signInWithPassword` + **`profiles.role`** (`manager` | `employee`).
- **Data** — `employees`, **`staff_requests`**, **`team_state`** loaded after sign-in (same queries as web hydrate).
- **Employee** — Home (welcome + your requests), **Messages** (`employee_chat_store` + threads), **Actions** (time off, callout, swap offer, availability note → `staff_requests`).
- **Manager** — Home stats, **Schedule** (placeholder), **Team** (roster list), **Actions** (all requests), **Messages** (manager’s `employee_chat_store` row).

Not ported yet (still use the web app): full **calendar / draft publish**, **Twilio callouts**, **employee availability grid**, **manager employee form**, legacy name/password login.

Use **`npm install --legacy-peer-deps`** in this folder if `npm install` errors on `react` / `react-dom` peer versions.

## Project identity

- App display name: **Red Poke Scheduler**
- Expo slug: `gm-callout` (change in `app.json` if you publish under another name)

## Store builds

When you’re ready for TestFlight / Play Internal testing, use [EAS Build](https://docs.expo.dev/build/introduction/) (`npm install -g eas-cli`, `eas build`).
