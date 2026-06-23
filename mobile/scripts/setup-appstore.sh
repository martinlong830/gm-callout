#!/usr/bin/env bash
# Interactive App Store / EAS setup. Run from repo: bash mobile/scripts/setup-appstore.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> Validating mobile app config..."
npm run validate:store

if ! command -v eas >/dev/null 2>&1; then
  echo "==> Installing eas-cli globally (or use: npx eas-cli)..."
  npm install -g eas-cli
fi

echo ""
echo "==> Log in to Expo (browser or token)"
eas login

echo ""
echo "==> Link this app to an EAS project (writes projectId into app.config.ts)"
eas init

echo ""
echo "==> Create production secrets (you will be prompted for values)"
echo "    Use your PRODUCTION Supabase URL/anon key and HTTPS web URL (not LAN)."
read -r -p "Continue creating EAS secrets? [y/N] " yn
if [[ "${yn:-}" =~ ^[Yy]$ ]]; then
  eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_URL --type string
  eas secret:create --scope project --name EXPO_PUBLIC_SUPABASE_ANON_KEY --type string
  eas secret:create --scope project --name EXPO_PUBLIC_GM_WEB_URL --type string
  eas secret:list
fi

echo ""
echo "==> Next steps (manual in Apple portals):"
echo "  1. developer.apple.com → Identifiers → register com.shiflow.app"
echo "  2. appstoreconnect.apple.com → New App → same bundle ID"
echo "  3. Deploy web app with HTTPS; privacy URL: https://YOUR-DOMAIN/privacy.html"
echo "  4. npm run build:ios   (first time: EAS creates signing certs)"
echo "  5. npm run submit:ios  (upload to TestFlight)"
echo ""
echo "See ../docs/APP_STORE.md and ../docs/APP_STORE_CONNECT.md"
