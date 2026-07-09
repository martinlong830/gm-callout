#!/usr/bin/env node
/**
 * Merge employee info from payroll CSV into Supabase employees.meta (and rates/tip points).
 * Usage: node scripts/seed-employee-info-from-csv.js [path-to-csv]
 */
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');
const {
  parseEmployeeInfoCsv,
  matchEmployeesToCsvRecords,
  mergeCsvRecordIntoEmployee,
} = require('./lib/employee-info-csv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const DEFAULT_CSV =
  '/Users/martinlong/Downloads/PAYROLL  SCHEDULE for Martin (3).xlsx - EMPLOYEE\'S INFO.csv';

async function main() {
  const csvPath = process.argv[2] || DEFAULT_CSV;
  if (!fs.existsSync(csvPath)) {
    console.error('CSV not found:', csvPath);
    process.exit(1);
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  const text = fs.readFileSync(csvPath, 'utf8');
  const records = parseEmployeeInfoCsv(text);
  console.log('Parsed', records.length, 'CSV row(s)');

  const admin = createClient(url, key);
  const { data: rows, error } = await admin
    .from('employees')
    .select('id, first_name, last_name, display_name, hourly_rate, meta, staff_type');
  if (error) throw error;

  const employees = (rows || []).map((row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    hourlyRate: row.hourly_rate != null ? Number(row.hourly_rate) : null,
    meta: row.meta || {},
    staffType: row.staff_type,
  }));

  const { matched, unmatchedCsv } = matchEmployeesToCsvRecords(employees, records);
  console.log('Matched', matched.length, 'of', records.length, 'CSV rows to employees');
  if (unmatchedCsv.length) {
    console.log('Unmatched CSV names:', unmatchedCsv.map((r) => r.name).join(', '));
  }

  let updated = 0;
  for (const { employee, record } of matched) {
    const before = JSON.stringify({
      meta: employee.meta,
      hourlyRate: employee.hourlyRate,
    });
    mergeCsvRecordIntoEmployee(employee, record, { onlyMissing: false });
    const after = JSON.stringify({
      meta: employee.meta,
      hourlyRate: employee.hourlyRate,
    });
    if (before === after) continue;
    const patch = {
      meta: employee.meta,
    };
    if (employee.hourlyRate != null) patch.hourly_rate = employee.hourlyRate;
    if (employee.tipPoint != null) {
      patch.meta = Object.assign({}, patch.meta, { tipPoint: employee.tipPoint });
    }
    const { error: upErr } = await admin.from('employees').update(patch).eq('id', employee.id);
    if (upErr) {
      console.warn(employee.displayName, upErr.message);
      continue;
    }
    console.log('Updated', employee.displayName);
    updated += 1;
  }
  console.log('Done.', updated, 'employee(s) updated.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
