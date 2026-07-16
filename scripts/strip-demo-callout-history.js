#!/usr/bin/env node
/**
 * Remove legacy seeded demo rows from team_state.callout_history.
 */
/* eslint-disable no-console */
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const TEAM_STATE_ROW_ID = 'main';

function norm(s) {
  return String(s || '')
    .trim()
    .toLowerCase();
}

function workerNamesMatch(a, b) {
  const wc = norm(a);
  const target = norm(b);
  if (!wc || !target) return false;
  if (wc === target) return true;
  const wa = wc.split(/\s+/).filter(Boolean);
  const ta = target.split(/\s+/).filter(Boolean);
  if (!wa.length || !ta.length) return false;
  if (wa[0] !== ta[0]) return false;
  if (wa.length === 1 || ta.length === 1) return wa[0] === ta[0];
  const wl = wa[wa.length - 1].replace(/\.$/, '');
  const tl = ta[ta.length - 1].replace(/\.$/, '');
  return wl === tl;
}

function isLegacySeededCalloutEntry(entry) {
  if (!entry) return false;
  const notified = entry.notified || [];
  const noResp = entry.noResponse || [];
  const accepted = entry.acceptedBy && entry.acceptedBy.name;
  function hasName(name) {
    return notified.some((n) => n && workerNamesMatch(n, name));
  }
  function noRespHas(name) {
    return noResp.some((n) => n && workerNamesMatch(n, name));
  }
  if (
    hasName('Alex R.') &&
    hasName('Taylor P.') &&
    hasName('Riley C.') &&
    accepted &&
    workerNamesMatch(accepted, 'Taylor P.') &&
    noRespHas('Alex R.') &&
    noRespHas('Riley C.')
  ) {
    return true;
  }
  if (
    hasName('Mia K.') &&
    hasName('Noah J.') &&
    hasName('Rosa H.') &&
    notified.length === 3 &&
    !accepted
  ) {
    return true;
  }
  return false;
}

async function main() {
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  const admin = createClient(url, key, { auth: { persistSession: false } });
  const { data: row, error: fetchErr } = await admin
    .from('team_state')
    .select('callout_history')
    .eq('id', TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (fetchErr) {
    console.error(fetchErr.message);
    process.exit(1);
  }
  const raw = row && Array.isArray(row.callout_history) ? row.callout_history : [];
  const next = raw.filter((e) => !isLegacySeededCalloutEntry(e));
  const removed = raw.length - next.length;
  if (removed === 0) {
    console.log('No legacy demo callout rows in team_state.callout_history.');
    return;
  }
  const { error: upErr } = await admin
    .from('team_state')
    .update({ callout_history: next })
    .eq('id', TEAM_STATE_ROW_ID);
  if (upErr) {
    console.error(upErr.message);
    process.exit(1);
  }
  console.log(`Removed ${removed} demo callout row(s). Hard-refresh the manager app.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
