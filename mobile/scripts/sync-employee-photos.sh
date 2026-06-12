#!/usr/bin/env sh
# Copy web roster photos into the mobile app bundle (run after adding files under ../assets/employee-photos).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$(cd "$(dirname "$0")/.." && pwd)/assets/employee-photos"
mkdir -p "$DEST"
cp "$ROOT/assets/employee-photos/"*.jpg "$ROOT/assets/employee-photos/"*.png "$DEST/" 2>/dev/null || true
echo "Synced employee photos to mobile/assets/employee-photos ($(ls "$DEST" | wc -l | tr -d ' ') files)"
