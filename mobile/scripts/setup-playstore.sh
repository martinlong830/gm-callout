#!/usr/bin/env bash
# Google Play / EAS Android setup. Run from repo: bash mobile/scripts/setup-playstore.sh
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
echo "==> Expo account"
eas whoami

echo ""
echo "==> EAS project"
eas project:info

echo ""
echo "==> Production environment variables"
echo "    Use HTTPS web URL (e.g. https://gm-callout.onrender.com), not LAN."
read -r -p "Create/update EAS production env vars from mobile/.env? [y/N] " yn
if [[ "${yn:-}" =~ ^[Yy]$ ]]; then
  if [[ ! -f .env ]]; then
    echo "Missing mobile/.env — copy .env.example and fill in Supabase values first."
    exit 1
  fi
  # shellcheck disable=SC1091
  set -a
  source .env
  set +a
  WEB_URL="${EXPO_PUBLIC_GM_WEB_URL:-}"
  if [[ "$WEB_URL" =~ localhost|192\.168\.|127\.0\.0\.1 ]]; then
    echo "⚠  EXPO_PUBLIC_GM_WEB_URL in .env is local/LAN."
    read -r -p "Use production https://gm-callout.onrender.com instead? [Y/n] " use_prod
    if [[ ! "${use_prod:-Y}" =~ ^[Nn]$ ]]; then
      WEB_URL="https://gm-callout.onrender.com"
    fi
  fi
  eas env:create production --name EXPO_PUBLIC_SUPABASE_URL --value "$EXPO_PUBLIC_SUPABASE_URL" --visibility plaintext --non-interactive --force
  eas env:create production --name EXPO_PUBLIC_SUPABASE_ANON_KEY --value "$EXPO_PUBLIC_SUPABASE_ANON_KEY" --visibility sensitive --non-interactive --force
  eas env:create production --name EXPO_PUBLIC_GM_WEB_URL --value "$WEB_URL" --visibility plaintext --non-interactive --force
  eas env:list --environment production
fi

echo ""
echo "==> Google Play service account (for eas submit)"
if [[ ! -f google-play-service-account.json ]]; then
  echo "  Place JSON key at: mobile/google-play-service-account.json"
  echo "  Play Console → Setup → API access → Create service account → Download key"
else
  echo "  ✓ google-play-service-account.json found"
fi

echo ""
echo "==> Next steps (manual in Google Play Console):"
echo "  1. play.google.com/console → Create app → package com.shiflow.app"
echo "  2. Complete store listing + Data safety + Content rating"
echo "  3. Privacy URL: https://gm-callout.onrender.com/privacy.html"
echo "  4. npm run build:android"
echo "  5. npm run submit:android   (or upload AAB manually to Internal testing)"
echo ""
echo "See ../docs/PLAY_STORE.md and ../docs/PLAY_STORE_CONNECT.md"
