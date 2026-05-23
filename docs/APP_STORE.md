# Ship Red Poke Scheduler to the App Store

This guide matches the **Expo SDK 54** app in `mobile/`. Bundle ID: **`com.redpoke.scheduler`**.

## What is already configured in the repo

- `mobile/app.config.ts` — app name, icons, iOS bundle ID, encryption export flag
- `mobile/eas.json` — production / preview / development build profiles
- `mobile/scripts/validate-appstore.js` — run `npm run validate:store`
- `docs/PRIVACY_POLICY.md` — host this at a public URL for App Store Connect
- `docs/APP_STORE_CONNECT.md` — listing copy, privacy labels, screenshots checklist

## Before you build (required)

1. **Apple Developer** — membership active (you signed up).
2. **App Store Connect** — [create a new app](https://appstoreconnect.apple.com):
   - Platform: iOS
   - Name: Red Poke Scheduler
   - Bundle ID: **com.redpoke.scheduler** (register the same ID under [Certificates, Identifiers](https://developer.apple.com/account/resources/identifiers/list) if needed)
3. **Production backend**
   - Supabase project with all migrations applied
   - Web server (`gm-callout`) deployed at **HTTPS** with `/api/portal/signin` working
4. **Privacy policy URL** — deploy the repo’s **`privacy.html`** (served at `https://your-domain/privacy.html` with `npm start` / your host) or publish `docs/PRIVACY_POLICY.md` elsewhere (required for review)

## One-time machine setup

```bash
cd mobile
npm install
npm run validate:store
bash scripts/setup-appstore.sh
```

Or step by step:

```bash
npm install -g eas-cli
eas login
cd mobile
npm install
eas init
```

`eas init` links the app to your Expo account and writes `extra.eas.projectId` in the cloud (keep `app.config.ts` as-is).

## Set production secrets (recommended)

From `mobile/`, store build-time env (not committed to git):

```bash
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --value "https://xxxx.supabase.co" --type string
eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "eyJ..." --type string
eas secret:create --scope project --name EXPO_PUBLIC_GM_WEB_URL --value "https://your-domain.com" --type string
```

List secrets: `eas secret:list`

For **submit**, you also need (from App Store Connect / Apple Developer):

```bash
eas secret:create --scope project --name APPLE_TEAM_ID --value "XXXXXXXXXX" --type string
eas secret:create --scope project --name ASC_APP_ID --value "1234567890" --type string
```

- **Team ID**: [Membership details](https://developer.apple.com/account#MembershipDetailsCard) → Team ID  
- **ASC App ID**: App Store Connect → your app → App Information → Apple ID (numeric)

## Build for iOS (TestFlight / App Store)

```bash
cd mobile
npm run build:ios
```

First build: answer prompts to let EAS create **distribution certificate** and **provisioning profile**.

When finished, open the build URL in the terminal or run:

```bash
npm run submit:ios
```

That uploads the latest production build to App Store Connect → **TestFlight**.

## Test on TestFlight

1. App Store Connect → TestFlight → add **Internal Testing** group
2. Install on iPhone, sign in with a real manager account
3. Confirm: login, roster, timecards, messages

## Submit for App Store review

In App Store Connect:

1. **App Privacy** — declare account / contact info / identifiers as used by Supabase and your API
2. **Screenshots** — 6.7" and 6.5" iPhone (required sizes in Media Manager)
3. **Description**, support URL, marketing URL (optional)
4. **Privacy Policy URL** — your hosted `PRIVACY_POLICY` page
5. Pricing → free or paid
6. Select the TestFlight build → **Add for Review** → Submit

Review typically takes 1–3 business days.

## Updates (1.0.1, 1.0.2, …)

Bump `version` in `mobile/app.config.ts`. Production profile uses `autoIncrement` for iOS build number.

```bash
cd mobile
npm run build:ios
npm run submit:ios
```

## Troubleshooting

| Issue | Fix |
|--------|-----|
| Login fails on TestFlight | `EXPO_PUBLIC_GM_WEB_URL` must be **HTTPS** production, not LAN IP |
| EAS “No project ID” | Run `eas init` in `mobile/` |
| Signing errors | `eas credentials` → iOS → reset distribution cert |
| Missing compliance | Already set: `ITSAppUsesNonExemptEncryption = false` |

## Android (optional)

```bash
cd mobile
eas build --platform android --profile production
eas submit --platform android --profile production
```
