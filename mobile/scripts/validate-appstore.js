#!/usr/bin/env node
/**
 * Pre-flight checks before `eas build --platform ios --profile production`.
 * Run: node scripts/validate-appstore.js
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
let ok = true;

function fail(msg) {
  console.error('✗', msg);
  ok = false;
}
function pass(msg) {
  console.log('✓', msg);
}

const requiredAssets = ['icon.png', 'splash-icon.png', 'adaptive-icon.png'];
for (const f of requiredAssets) {
  if (!fs.existsSync(path.join(root, 'assets', f))) fail(`Missing assets/${f}`);
  else pass(`assets/${f}`);
}

if (!fs.existsSync(path.join(root, 'app.config.ts'))) fail('Missing app.config.ts');
else pass('app.config.ts');

if (!fs.existsSync(path.join(root, 'eas.json'))) fail('Missing eas.json');
else pass('eas.json');

const cfg = fs.readFileSync(path.join(root, 'app.config.ts'), 'utf8');
if (!cfg.includes('com.redpoke.scheduler')) fail('com.redpoke.scheduler not in app.config.ts');
else pass('Bundle ID / package com.redpoke.scheduler (iOS + Android)');

const eas = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
if (eas.build?.production?.android?.buildType === 'app-bundle') pass('Android production builds AAB (Play Store)');
else fail('eas.json production.android.buildType should be app-bundle');

if (cfg.includes('projectId: process.env.EAS_PROJECT_ID') && !process.env.EAS_PROJECT_ID) {
  console.warn('⚠ Run `eas init` in mobile/ to link an EAS project (or set EAS_PROJECT_ID)');
}

const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) {
  const env = fs.readFileSync(envPath, 'utf8');
  if (/localhost|192\.168\.|127\.0\.0\.1/.test(env) && env.includes('EXPO_PUBLIC_GM_WEB_URL')) {
    console.warn('⚠ .env uses localhost/LAN for EXPO_PUBLIC_GM_WEB_URL — use production HTTPS in EAS secrets for App Store builds');
  }
}

console.log('');
if (ok) {
  console.log('Ready for EAS setup. See docs/APP_STORE.md and docs/PLAY_STORE.md');
  process.exit(0);
} else {
  console.log('Fix the issues above before building.');
  process.exit(1);
}
