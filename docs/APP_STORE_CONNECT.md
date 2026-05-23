# App Store Connect listing (copy/paste)

Use this when creating **Red Poke Scheduler** in [App Store Connect](https://appstoreconnect.apple.com).

## App information

| Field | Value |
|--------|--------|
| **Name** | Red Poke Scheduler |
| **Bundle ID** | `com.redpoke.scheduler` |
| **SKU** | `redpoke-scheduler` (any unique string you choose) |
| **Primary language** | English (U.S.) |
| **Category** | Business (primary), Productivity (secondary, optional) |
| **Content rights** | Does not contain third-party content (unless you add licensed assets later) |
| **Age rating** | Complete the questionnaire — expect **4+** for a workplace scheduling app with no user-generated public content |

## Export compliance

The app uses HTTPS only (no custom encryption). In App Store Connect when asked:

- **Uses encryption?** Yes (standard HTTPS)
- **Exempt?** Yes — qualifies for exemption (already set in `app.config.ts`: `ITSAppUsesNonExemptEncryption = false`)

## App Privacy (nutrition labels)

Declare what the app collects (adjust if your deployment differs):

| Data type | Linked to user | Used for |
|-----------|----------------|----------|
| Name | Yes | App functionality |
| Email / account ID | Yes | App functionality |
| Other user content (messages, schedule, punches) | Yes | App functionality |
| Identifiers (session) | Yes | App functionality |

**Tracking:** No  
**Third parties:** Supabase (database/auth), your hosted web API

## Description (starter)

**Subtitle (30 chars):** Staff scheduling & timecards

**Description:**

Red Poke Scheduler helps restaurant teams manage schedules, time-off and swap requests, manager messaging, and timecards.

Managers can review roster assignments, edit punch times, and run pay-week timecards. Staff use the web portal or kiosk for clock-in; this app focuses on manager workflows on iPhone and iPad.

Sign-in uses your employer’s Red Poke account. Contact your administrator for access.

**Keywords:** schedule, restaurant, timecard, roster, shift, manager, staff

**Support URL:** Your company support page (required)  
**Marketing URL:** Optional  
**Privacy Policy URL:** Public URL where you host `docs/PRIVACY_POLICY.md`

## Screenshots

Capture from a **production or staging** build on a physical device or simulator:

1. Login  
2. Manager home / roster  
3. Timecards week view  
4. Messages (if enabled)

Required sizes (check App Store Connect for current list): typically **6.7"** and **6.5"** iPhone, plus **12.9"** iPad if you support tablet (`supportsTablet: true`).

## TestFlight notes for reviewers

In **App Review Information**:

- Provide a **demo manager** account (username/password) that works against production HTTPS  
- Notes: “Manager-only mobile app; employees use web/kiosk. Login hits `/api/portal/signin` on our server.”

## Versioning

- Marketing version: `version` in `mobile/app.config.ts` (e.g. `1.0.0`)  
- Build number: auto-incremented by EAS production profile
