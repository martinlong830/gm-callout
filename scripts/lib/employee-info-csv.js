/**
 * Parse Red Poke employee info CSV (payroll schedule export).
 * Shared by seed script and browser presets in app.js.
 */
/* eslint-disable no-console */

const STAFF_SECTIONS = [
  { marker: 'FRONT OF THE HOUSE', staffType: 'Bartender', title: 'FRONT OF THE HOUSE' },
  { marker: 'BACK OF THE HOUSE - PREP / DISHWASHER', staffType: 'Server', title: 'DELIVERY / DISHWASHER' },
  { marker: 'BACK OF THE HOUSE', staffType: 'Kitchen', title: 'BACK OF THE HOUSE' },
];

function normNameKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameLastToken(s) {
  const parts = normNameKey(s).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function nameFirstToken(s) {
  const parts = normNameKey(s).split(' ').filter(Boolean);
  return parts.length ? parts[0] : '';
}

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

function parseTipPoint(raw) {
  const s = String(raw || '').trim();
  if (!s || /^n\/?a$/i.test(s)) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n;
}

function parsePayNumber(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : Math.round(n * 100) / 100;
}

function parseEmployeeInfoCsv(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const records = [];
  let current = null;

  lines.forEach((line) => {
    const section = STAFF_SECTIONS.find((s) => line.toUpperCase().indexOf(s.marker) === 0);
    if (section) {
      current = section;
      return;
    }
    if (!current || line.toUpperCase().indexOf('TEAM MEMBERS') === 0) return;
    const cols = parseCsvLine(line);
    const name = cols[0];
    if (!name) return;
    const nameUp = name.toUpperCase();
    if (name.indexOf(',') >= 0) return;
    if (/^(RATE|ADJUSMENT|POINT|HOURS|TIP|PAY)$/i.test(nameUp)) return;
    if (!cols[1] && !cols[2] && !cols[8]) return;
    const emergencyName = cols[3] || '';
    const emergencyPhone = cols[4] || '';
    const ssn = cols[5] || '';
    const itin = cols[6] || '';
    records.push({
      name: name.toUpperCase(),
      staffType: current.staffType,
      sectionTitle: current.title,
      position: cols[1] || '',
      hiringDate: cols[2] || '',
      emergencyContact: [emergencyName, emergencyPhone].filter(Boolean).join(' · '),
      emergencyName,
      emergencyPhone,
      ssn,
      itin,
      birthDate: cols[7] || '',
      hoursRate: parsePayNumber(cols[8]),
      payAdjustment: parsePayNumber(cols[9]),
      tipPoint: parseTipPoint(cols[10]),
    });
  });
  return records;
}

function splitDisplayName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] || '', last: '' };
  const last = parts.pop();
  return { first: parts.join(' '), last };
}

const CSV_NAME_ALIASES = {
  'seid sumog oy': 'sied sumog oy',
  'angel gella': 'angelyn gella',
  'abel lujon': 'abel lujan',
};

function normCsvNameKey(name) {
  const n = normNameKey(name);
  return CSV_NAME_ALIASES[n] || n;
}

function namesLooselyMatch(a, b) {
  const na = normCsvNameKey(a);
  const nb = normCsvNameKey(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = nameFirstToken(na);
  const fb = nameFirstToken(nb);
  const la = nameLastToken(na);
  const lb = nameLastToken(nb);
  if (fa === fb && la === lb) return true;
  if (la === lb && (fa.indexOf(fb) === 0 || fb.indexOf(fa) === 0)) return true;
  if (fa === fb && (la.indexOf(lb) === 0 || lb.indexOf(la) === 0)) return true;
  return false;
}

function employeeMatchesCsvRecord(emp, rec) {
  const dn = normNameKey(emp.displayName || `${emp.firstName || ''} ${emp.lastName || ''}`);
  const fn = normNameKey(emp.firstName);
  const ln = normNameKey(emp.lastName);
  const rn = normCsvNameKey(rec.name);
  const { first, last } = splitDisplayName(rec.name);
  const rf = normCsvNameKey(first);
  const rl = normCsvNameKey(last);
  if (dn === rn) return true;
  if (fn === rf && ln === rl) return true;
  if (nameFirstToken(dn) === nameFirstToken(rn) && nameLastToken(dn) === nameLastToken(rn)) return true;
  if (nameFirstToken(fn) === nameFirstToken(rf) && nameLastToken(ln) === nameLastToken(rl)) return true;
  if (namesLooselyMatch(dn, rn)) return true;
  if (namesLooselyMatch(fn + ' ' + ln, rf + ' ' + rl)) return true;
  return false;
}

function csvRecordToMeta(rec) {
  const meta = {};
  if (rec.position) meta.position = rec.position;
  if (rec.hiringDate) meta.hiringDate = rec.hiringDate;
  if (rec.emergencyContact) meta.emergencyContact = rec.emergencyContact;
  if (rec.ssn) meta.ssn = rec.ssn;
  if (rec.itin) meta.itin = rec.itin;
  if (rec.birthDate) meta.birthDate = rec.birthDate;
  if (rec.payAdjustment != null) meta.payAdjustment = rec.payAdjustment;
  return meta;
}

function mergeCsvRecordIntoEmployee(emp, rec, opts) {
  opts = opts || {};
  const onlyMissing = !!opts.onlyMissing;
  emp.meta = emp.meta && typeof emp.meta === 'object' ? Object.assign({}, emp.meta) : {};
  const patch = csvRecordToMeta(rec);
  Object.keys(patch).forEach((k) => {
    if (onlyMissing && emp.meta[k] != null && String(emp.meta[k]).trim() !== '') return;
    emp.meta[k] = patch[k];
  });
  if (rec.hoursRate != null && (emp.hourlyRate == null || !onlyMissing)) {
    emp.hourlyRate = rec.hoursRate;
  }
  if (rec.tipPoint != null && (emp.tipPoint == null || !onlyMissing)) {
    emp.tipPoint = rec.tipPoint;
    emp.meta.tipPoint = rec.tipPoint;
  }
  return emp;
}

function matchEmployeesToCsvRecords(employees, records) {
  const matched = [];
  const unmatchedCsv = [];
  const usedEmpIds = new Set();
  records.forEach((rec) => {
    const hit = (employees || []).find((emp) => {
      if (usedEmpIds.has(emp.id)) return false;
      return employeeMatchesCsvRecord(emp, rec);
    });
    if (hit) {
      usedEmpIds.add(hit.id);
      matched.push({ employee: hit, record: rec });
    } else {
      unmatchedCsv.push(rec);
    }
  });
  return { matched, unmatchedCsv };
}

module.exports = {
  STAFF_SECTIONS,
  normNameKey,
  parseEmployeeInfoCsv,
  employeeMatchesCsvRecord,
  csvRecordToMeta,
  mergeCsvRecordIntoEmployee,
  matchEmployeesToCsvRecords,
};
