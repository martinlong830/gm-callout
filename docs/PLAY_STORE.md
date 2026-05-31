# Ship Red Poke Scheduler to Google Play

This guide matches the **Expo SDK 54** app in `mobile/`. Android package: **`com.redpoke.scheduler`**.

## What is already configured in the repo

- `mobile/app.config.ts` — app name, icons, Android package, `versionCode`
- `mobile/eas.json` — production **AAB** builds + internal-track submit profile
- `npm run build:android` / `npm run submit:android` in `mobile/package.json`
- Production web API: **`https://gm-callout.onrender.com`** (`/health`, `/api/portal/signin`)
- Privacy policy: host **`privacy.html`** at `https://gm-callout.onrender.com/privacy.html`

## Before you build (required)

1. **Google Play Developer account** — [play.google.com/console](https://play.google.com/console) ($25 one-time).
2. **Play Console app** — create app **Red Poke Scheduler** with package **`com.redpoke.scheduler`** (must match `app.config.ts` exactly).
3. **Production backend** — Supabase + web server on HTTPS (already on Render for this project).
4. **EAS production env vars** — Supabase URL/key + `EXPO_PUBLIC_GM_WEB_URL` (see below).
5. **Service account JSON** — for `eas submit` (one-time Play Console setup).

## One-time machine setup

```bash
cd mobile
npm install
npm run validate:store
bash scripts/setup-playstore.sh
```

Or step by step:

```bash
npm install -g eas-cli   # optional; npx eas-cli works too
eas login
cd mobile
npm install
eas init                 # already linked if projectId is in app.config.ts
```

## Set production environment variables (EAS)

Recommended (not committed to git):

```bash
cd mobile
eas env:create production --name EXPO_PUBLIC_SUPABASE_URL --value "https://YOUR_PROJECT.supabase.co" --visibility plaintext --non-interactive
eas env:create production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "eyJ..." --visibility sensitive --non-interactive
eas env:create production --name EXPO_PUBLIC_GM_WEB_URL --value "https://gm-callout.onrender.com" --visibility plaintext --non-interactive
```

List: `eas env:list --environment production`

For this deployment, **`EXPO_PUBLIC_GM_WEB_URL` must be HTTPS** — not `localhost` or a LAN IP. Login calls `/api/portal/signin` on that host.

## Google Play service account (for `eas submit`)

1. Play Console → **Setup** → **API access**
2. Link a Google Cloud project (or create one)
3. **Create service account** → grant **Release manager** (or Admin) on the app
4. Download JSON key → save as **`mobile/google-play-service-account.json`** (gitignored)
5. First upload: Play Console may require completing **App content** (privacy policy, data safety, content rating) before any release

`eas.json` submit profile uses:

- **track:** `internal` (closed testing — good for staff first)
- **releaseStatus:** `draft` (you promote manually in Play Console)

Change `track` to `production` when ready for public listing.

## Build Android (Play Store AAB)

```bash
cd mobile
npm run build:android
```

First build: EAS creates/upload the **Android keystore** (keep it in EAS — do not lose it).

When finished, open the build URL from the terminal.

## Submit to Play Console

```bash
cd mobile
npm run submit:android
```

Or upload the `.aab` manually: Play Console → **Testing** → **Internal testing** → **Create new release** → upload AAB.

## Test before wide rollout

1. Play Console → **Internal testing** → add tester emails (or Google Group)
2. Install from the Play Store test link on an Android phone
3. Sign in with a real manager account (`Martin Long` / `redpoke` against production)
4. Confirm: login, roster, messages, requests

## Submit for public production release

In Play Console:

1. **Store listing** — title, short/full description (see `docs/PLAY_STORE_CONNECT.md`)
2. **App content** — privacy policy URL, data safety form, ads declaration (No ads)
3. **Content rating** — questionnaire (expect low rating for workplace app)
4. **Screenshots** — phone required (see PLAY_STORE_CONNECT.md)
5. Promote internal test build → **Production** (or closed/open testing first)

Review can take from hours to several days.

## Updates (1.0.1, 1.0.2, …)

Bump `version` in `mobile/app.config.ts`. Production profile uses `autoIncrement` for Android `versionCode`.

```bash
cd mobile
npm run build:android
npm run submit:android
```

## Troubleshooting

| Issue | Fix |
|--------|-----|
| Login fails on device | `EXPO_PUBLIC_GM_WEB_URL` must be production HTTPS, not LAN |
| `serviceAccountKeyPath` missing | Save JSON to `mobile/google-play-service-account.json` |
| Package name mismatch | Play app must use `com.redpoke.scheduler` |
| Upload rejected | Complete Data safety + Privacy policy in Play Console |
| Keystore lost | Use `eas credentials --platform android` — never delete EAS keystore |

## Optional: APK for sideload (not Play Store)

```bash
cd mobile
npm run build:android:preview
```

Downloads an **APK** for direct install (internal distribution).
