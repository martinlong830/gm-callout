#!/usr/bin/env node
/* eslint-disable no-console */
const os = require('os');
const fs = require('fs');
const path = require('path');

function pickLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

const ip = pickLanIp();
const url = `http://${ip}:8000`;
console.log(`LAN web URL for mobile/.env: ${url}`);
console.log('Phone must be on the same Wi‑Fi. Expo Go on iOS may still require HTTPS — use Render URL instead.');

const envPath = path.join(__dirname, '..', 'mobile', '.env');
if (fs.existsSync(envPath)) {
  const raw = fs.readFileSync(envPath, 'utf8');
  if (/^EXPO_PUBLIC_GM_WEB_URL=/m.test(raw)) {
    const next = raw.replace(/^EXPO_PUBLIC_GM_WEB_URL=.*$/m, `EXPO_PUBLIC_GM_WEB_URL=${url}`);
    fs.writeFileSync(envPath, next);
    console.log(`Updated ${envPath}`);
  }
}
