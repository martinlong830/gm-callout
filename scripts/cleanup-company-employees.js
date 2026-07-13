#!/usr/bin/env node
/**
 * Clear employees belonging to company name "test" (or --company-id / --name).
 * Does NOT touch Red Poke (a0000000-0000-4000-8000-000000000001).
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in env (or .env).
 *
 * Usage:
 *   node scripts/cleanup-company-employees.js
 *   node scripts/cleanup-company-employees.js --name test
 *   node scripts/cleanup-company-employees.js --company-id <uuid>
 *   node scripts/cleanup-company-employees.js --dry-run
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const RED_POKE_COMPANY_ID = 'a0000000-0000-4000-8000-000000000001';

function loadDotEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  text.split('\n').forEach((line) => {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) return;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[m[1]] == null || process.env[m[1]] === '') process.env[m[1]] = v;
  });
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i === -1 || i + 1 >= process.argv.length) return null;
  return process.argv[i + 1];
}

async function main() {
  loadDotEnv();
  const url = process.env.SUPABASE_URL || process.env.EXPO_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Need SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');
  const nameArg = argValue('--name') || 'test';
  const companyIdArg = argValue('--company-id');

  const admin = createClient(url, key, { auth: { persistSession: false } });

  let company;
  if (companyIdArg) {
    const { data, error } = await admin
      .from('companies')
      .select('id, name, team_state_id')
      .eq('id', companyIdArg)
      .maybeSingle();
    if (error) throw error;
    company = data;
  } else {
    const { data, error } = await admin
      .from('companies')
      .select('id, name, team_state_id')
      .ilike('name', nameArg)
      .limit(5);
    if (error) throw error;
    if (!data || !data.length) {
      console.error(`No company named "${nameArg}".`);
      process.exit(1);
    }
    if (data.length > 1) {
      console.error(
        'Multiple matches; pass --company-id:',
        data.map((c) => `${c.name} (${c.id})`).join(', ')
      );
      process.exit(1);
    }
    company = data[0];
  }

  if (!company) {
    console.error('Company not found.');
    process.exit(1);
  }
  if (company.id === RED_POKE_COMPANY_ID) {
    console.error('Refusing to wipe Red Poke employees.');
    process.exit(1);
  }

  console.log(`Company: ${company.name} (${company.id})`);

  const { data: emps, error: empErr } = await admin
    .from('employees')
    .select('id, display_name, company_id')
    .eq('company_id', company.id);
  if (empErr) {
    console.error(
      'employees select failed (apply supabase/fix-employees-company-id-oneshot.sql if company_id is missing):',
      empErr.message
    );
    process.exit(1);
  }

  console.log(`Employees tagged to this company: ${(emps || []).length}`);
  (emps || []).forEach((e) => console.log(`  - ${e.display_name} (${e.id})`));

  if (dryRun) {
    console.log('Dry run — no deletes.');
    process.exit(0);
  }

  if (emps && emps.length) {
    const { error: delErr } = await admin.from('employees').delete().eq('company_id', company.id);
    if (delErr) throw delErr;
    console.log(`Deleted ${emps.length} employee row(s).`);
  } else {
    console.log(
      'No employees with this company_id. If Team still showed Red Poke staff, that was the global employees RLS leak — apply the company_id migration; no delete needed.'
    );
  }

  const teamStateId = company.team_state_id || company.id;
  const { data: ts, error: tsErr } = await admin
    .from('team_state')
    .select('id, schedule_assignments')
    .eq('id', teamStateId)
    .maybeSingle();
  if (tsErr) throw tsErr;
  if (ts) {
    const assignments = {};
    const sched = ts.schedule_assignments && typeof ts.schedule_assignments === 'object'
      ? ts.schedule_assignments
      : {};
    Object.keys(sched).forEach((rid) => {
      assignments[rid] = {};
    });
    const { error: upErr } = await admin
      .from('team_state')
      .update({ schedule_assignments: assignments, draft_schedule: {} })
      .eq('id', teamStateId);
    if (upErr) throw upErr;
    console.log(`Reset team_state ${teamStateId} assignments to empty/unassigned shells.`);
  } else {
    console.log(`No team_state row ${teamStateId} yet (created on first manager login).`);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
