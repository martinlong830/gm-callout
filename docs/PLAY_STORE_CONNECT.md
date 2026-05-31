# Google Play Console listing (copy/paste)

Use this when creating **Red Poke Scheduler** in [Google Play Console](https://play.google.com/console).

## App information

| Field | Value |
|--------|--------|
| **App name** | Red Poke Scheduler |
| **Package name** | `com.redpoke.scheduler` (set at create time — cannot change later) |
| **Default language** | English (United States) |
| **App or game** | App |
| **Free or paid** | Free |

## Store listing

**Short description (80 chars max):**

Staff scheduling, time-off requests, and manager messaging for Red Poke.

**Full description:**

Red Poke Scheduler helps restaurant teams manage schedules, time-off and swap requests, manager messaging, and timecards.

Managers can review roster assignments and respond to staff requests from their phone. Employees can submit time-off, callouts, and availability notes.

Sign-in uses your employer’s Red Poke account. Contact your administrator for access.

**App category:** Business  
**Tags (if offered):** scheduling, restaurant, staff, manager

**Contact email:** Your support email (required)  
**Privacy policy URL:** `https://gm-callout.onrender.com/privacy.html`

## Data safety (starter answers)

Adjust if your deployment differs:

| Question | Typical answer |
|----------|----------------|
| Collect or share user data? | Yes — collected |
| Data encrypted in transit? | Yes (HTTPS) |
| Account creation | Required (employer-provided accounts) |
| Data types | Name, email/account ID, messages, schedule/work data |
| Purpose | App functionality |
| Sold to third parties? | No |
| Tracking | No |

Third parties: **Supabase** (database/auth), **Render** (web API hosting).

## Content rating

Complete the IARC questionnaire. Workplace scheduling with login and messaging typically rates **Everyone** or low teen — no violence, gambling, or user-generated public social feeds.

## Screenshots

Capture from a **production** build on a physical Android phone or emulator:

1. Login  
2. Manager home / roster  
3. Messages  
4. Staff requests (manager or employee view)

Phone screenshots are required; 7-inch tablet optional.

## Testing tracks (recommended order)

1. **Internal testing** — you + 1–2 managers (fastest)  
2. **Closed testing** — full manager team via email list  
3. **Production** — all staff can install from Play Store

## Reviewer notes (if asked)

Provide a **demo manager** account that works on production:

- Notes: “B2B workplace app for one restaurant group. Login uses name + password via our HTTPS API. Employees may use web kiosk for clock-in; mobile app focuses on schedules, requests, and messaging.”

## Versioning

- **User-visible version:** `version` in `mobile/app.config.ts` (e.g. `1.0.0`)  
- **versionCode:** auto-incremented by EAS production builds
