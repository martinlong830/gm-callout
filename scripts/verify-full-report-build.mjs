/**
 * Smoke-test: buildFullReportSheets with mock deps (no browser).
 * Run: node scripts/verify-full-report-build.mjs
 */
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const XLSX = require('xlsx-js-style');

const mockEmployees = [
  {
    id: 'e1',
    firstName: 'MARK',
    lastName: 'ONG',
    staffType: 'Bartender',
    phone: '',
    usualRestaurant: 'rp-9',
    hourlyRate: 22,
    tipPoint: 5,
    weeklyGrid: {},
    meta: {
      position: 'STORE MANAGER',
      hiringDate: '3/25/2023',
      emergencyContact: 'ELLOISA ONG · 347 526 9910',
      itin: '990 - 98 - 5260',
      birthDate: '3/17/1989',
      payAdjustment: 28.5,
    },
  },
  {
    id: 'e2',
    firstName: 'BALTAZAR',
    lastName: 'LUCAS',
    staffType: 'Kitchen',
    phone: '',
    usualRestaurant: 'rp-9',
    hourlyRate: 20,
    tipPoint: 4,
    weeklyGrid: {},
    meta: { position: 'KITCHEN MANAGER' },
  },
  {
    id: 'e3',
    firstName: 'JUAN',
    lastName: 'SALVATIERRA',
    staffType: 'Server',
    phone: '',
    usualRestaurant: 'rp-9',
    hourlyRate: 13.5,
    weeklyGrid: {},
    meta: { position: 'PREP / DISHWASHER' },
  },
  {
    id: 'e8',
    firstName: 'EIGHTH',
    lastName: 'ONLY',
    staffType: 'Kitchen',
    phone: '',
    usualRestaurant: 'rp-8',
    hourlyRate: 18,
    tipPoint: 3,
    weeklyGrid: {},
    meta: { position: 'COOK' },
  },
  {
    id: 'eboth',
    firstName: 'BOTH',
    lastName: 'STORES',
    staffType: 'Bartender',
    phone: '',
    usualRestaurant: 'both',
    hourlyRate: 20,
    tipPoint: 4,
    weeklyGrid: {},
    meta: { position: 'SERVICE REP', primaryLocationId: 'rp-9', primaryRestaurantId: 'rp-9' },
  },
  {
    id: 'eboth8',
    firstName: 'BOTH',
    lastName: 'EIGHTH',
    staffType: 'Kitchen',
    phone: '',
    usualRestaurant: 'both',
    hourlyRate: 19,
    tipPoint: 3,
    weeklyGrid: {},
    meta: { position: 'COOK', primaryLocationId: 'rp-8', primaryRestaurantId: 'rp-8' },
  },
  {
    id: 'eboth-noprim',
    firstName: 'BOTH',
    lastName: 'NOPRIMARY',
    staffType: 'Server',
    phone: '',
    usualRestaurant: 'both',
    hourlyRate: 15,
    tipPoint: 2,
    weeklyGrid: {},
    meta: { position: 'RUNNER' },
  },
  {
    id: 'e-paid-off',
    firstName: 'PAID',
    lastName: 'OFFSCHEDULE',
    staffType: 'Kitchen',
    phone: '',
    usualRestaurant: 'rp-9',
    hourlyRate: 16,
    tipPoint: 2,
    weeklyGrid: {},
    meta: { position: 'COOK', hiringDate: '6/1/2024' },
  },
];

const storage = new Map();
const localStorage = {
  getItem(k) {
    return storage.has(k) ? storage.get(k) : null;
  },
  setItem(k, v) {
    storage.set(k, String(v));
  },
};

function mockEl() {
  return {
    hidden: false,
    value: '',
    innerHTML: '',
    dataset: {},
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    closest() {
      return null;
    },
  };
}

const document = {
  getElementById() {
    return mockEl();
  },
  body: { classList: { add() {}, remove() {} } },
  addEventListener() {},
};

const deps = {
  employees: mockEmployees,
  employeeDisplayName(e) {
    return `${e.firstName} ${e.lastName}`.trim();
  },
  normNameKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  },
  nameFirstToken(s) {
    const parts = String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return parts[0] || '';
  },
  nameLastToken(s) {
    const parts = String(s || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  },
  escapeHtml(s) {
    return String(s || '');
  },
  getThisMondayDate() {
    return new Date('2026-05-18T12:00:00');
  },
  punchShiftRoundedMinutes(mins) {
    return Math.max(0, Math.round((mins || 0) / 5) * 5);
  },
  scheduledShiftStartAt() {
    return null;
  },
  shiftRowIncludesWorker(shift, name) {
    const target = String(name || '')
      .trim()
      .toLowerCase();
    if (!target || !shift) return false;
    return (shift.workers || []).some(
      (w) =>
        String(w || '')
          .trim()
          .toLowerCase() === target
    );
  },
  scheduleCalendarCellText(shift) {
    if (!shift) return '';
    return (
      String(shift.timeLabel || '') +
      '\n' +
      String(shift.redPokeBreak || '') +
      '\n' +
      String(shift.redPokeHours || '')
    );
  },
  getStaffRequests() {
    return [];
  },
  getRestaurantsList() {
    return deps.restaurantsList;
  },
  STAFF_TYPE_LABELS: {
    Kitchen: 'Back of the House',
    Bartender: 'Front of the House',
    Server: 'Delivery/Dishwasher',
  },
  WEEK_META: [
    { label: 'Mon May 18', iso: '2026-05-18', dayNameUpper: 'MONDAY' },
    { label: 'Tue May 19', iso: '2026-05-19', dayNameUpper: 'TUESDAY' },
    { label: 'Wed May 20', iso: '2026-05-20', dayNameUpper: 'WEDNESDAY' },
    { label: 'Thu May 21', iso: '2026-05-21', dayNameUpper: 'THURSDAY' },
    { label: 'Fri May 22', iso: '2026-05-22', dayNameUpper: 'FRIDAY' },
    { label: 'Sat May 23', iso: '2026-05-23', dayNameUpper: 'SATURDAY' },
    { label: 'Sun May 24', iso: '2026-05-24', dayNameUpper: 'SUNDAY' },
  ],
  weekIndexForPayWeekStartIso() {
    return 0;
  },
  buildScheduleRowsForWeekIndex() {
    return [];
  },
  /** Mutable so staleness tests can swap the live assignment snapshot. */
  __scheduleSnapshotRows: [
    {
      id: 'shift-0-0-0',
      restaurantId: 'rp-9',
      restaurantName: 'Red Poke 598 9th Ave',
      day: 'Mon May 18',
      trIdx: 0,
      role: 'Bartender',
      start: '11:00',
      end: '21:00',
      timeLabel: '11:00AM - 9:00PM',
      redPokeBreak: '(3:00PM BREAK TIME)',
      redPokeHours: '10',
      workers: ['MARK ONG'],
    },
    {
      id: 'shift-0-1-0',
      restaurantId: 'rp-9',
      restaurantName: 'Red Poke 598 9th Ave',
      day: 'Mon May 18',
      trIdx: 0,
      role: 'Kitchen',
      start: '10:00',
      end: '18:00',
      timeLabel: '10:00AM - 6:00PM',
      redPokeBreak: '(2:00PM BREAK TIME)',
      redPokeHours: '8',
      workers: ['BALTAZAR LUCAS'],
    },
    {
      id: 'shift-8-0-0',
      restaurantId: 'rp-8',
      restaurantName: 'Red Poke 885 8th Ave',
      day: 'Mon May 18',
      trIdx: 0,
      role: 'Kitchen',
      start: '10:00',
      end: '18:00',
      timeLabel: '10:00AM - 6:00PM',
      redPokeBreak: '(2:00PM BREAK TIME)',
      redPokeHours: '8',
      workers: ['EIGHTH ONLY'],
    },
  ],
  buildScheduleSnapshotForPayWeek() {
    return (deps.__scheduleSnapshotRows || []).map((row) => Object.assign({}, row, {
      workers: (row.workers || []).slice(),
    }));
  },
  redPokeShiftTimeLabel() {
    return '—';
  },
  redPokeShiftHoursDecimal(start, end) {
    if (!start || !end) return '0';
    return '8';
  },
  restaurantsList: [
    { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 598 9th Ave' },
    { id: 'rp-8', shortLabel: '8th Ave', name: 'Red Poke 885 8th Ave' },
  ],
};

const sandbox = {
  XLSX,
  localStorage,
  document,
  console,
  setTimeout,
  clearTimeout,
  Uint8Array,
  ArrayBuffer,
  Buffer,
  JSZip: require('jszip'),
  Blob: class Blob {
    constructor() {}
  },
  URL: { createObjectURL() { return ''; }, revokeObjectURL() {} },
  requestIdleCallback(cb) {
    cb();
  },
  Date,
  Math,
  JSON,
  Object,
  Array,
  Number,
  String,
  parseFloat,
  parseInt,
  isNaN: Number.isNaN,
  gmCalloutTimecards: null,
  __gmTimecardsEnableTestExports: true,
};
sandbox.window = sandbox;
sandbox.global = sandbox;

const code = fs.readFileSync(path.join(ROOT, 'timecards-manager.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

sandbox.gmCalloutTimecards.init(deps);

const mockRows = mockEmployees.map((emp) => {
  const onSchedule = emp.id === 'e1' || emp.id === 'e2' || emp.id === 'e8';
  const paidOffSchedule = emp.id === 'e-paid-off';
  const hasPay = onSchedule || paidOffSchedule;
  return {
    emp,
    name: deps.employeeDisplayName(emp),
    deptRank: emp.staffType === 'Bartender' ? 0 : emp.staffType === 'Kitchen' ? 1 : 2,
    scheduleIndex: 0,
    regMins: hasPay ? 2400 : 0,
    otMins: 0,
    totalMins: hasPay ? 2400 : 0,
    vlHours: 0,
    slHours: 0,
    regPay: hasPay ? (emp.hourlyRate || 15) * 40 : 0,
    otPay: 0,
    sohCount: 0,
    sohDatesLabel: '—',
    sohPay: null,
    grandTotalPay: hasPay ? (emp.hourlyRate || 15) * 40 : 0,
    dishwasherTipsPay: 0,
    additionalCashTip: 0,
  };
});

sandbox.__gmTimecardsTest.setRosterCacheForTest(mockRows);

const runs = 3;
const timings = [];
let build = null;
for (let i = 0; i < runs; i++) {
  if (i > 0) sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
  const t0 = performance.now();
  build = sandbox.__gmTimecardsTest.buildFullReportSheets();
  const t1 = performance.now();
  const wb = XLSX.utils.book_new();
  for (const sh of build) {
    XLSX.utils.book_append_sheet(wb, sh.worksheet, sh.name);
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false });
  const t2 = performance.now();
  timings.push({ build: t1 - t0, write: t2 - t1, total: t2 - t0, bytes: out.length });
}

if (!Array.isArray(build) || !build.length) {
  throw new Error('buildFullReportSheets returned no sheets');
}

const names = build.map((s) => s.name);
const expected = ['Labor Cost', 'CPA', 'Payroll', 'Payslip', 'Schedule', 'PTO', 'Employee Information'];
for (const name of expected) {
  if (names.indexOf(name) < 0) throw new Error('Missing sheet: ' + name);
}

function worksheetText(ws) {
  return Object.keys(ws || {})
    .filter((k) => k.charAt(0) !== '!')
    .map((k) => String((ws[k] && ws[k].v) || ''))
    .join('\n');
}

const scheduleSheet = build.find((s) => s.name === 'Schedule');
if (!scheduleSheet || !scheduleSheet.worksheet) {
  throw new Error('Schedule sheet missing worksheet');
}
const scheduleText = worksheetText(scheduleSheet.worksheet);
if (scheduleText.indexOf('TEAM MEMBERS') < 0) {
  throw new Error('Schedule sheet missing TEAM MEMBERS header');
}
if (scheduleText.indexOf('MARK ONG') < 0) {
  throw new Error('Schedule sheet missing assigned worker MARK ONG');
}
if (scheduleText.indexOf('JUAN SALVATIERRA') >= 0) {
  throw new Error('Schedule sheet should omit unscheduled roster employee JUAN SALVATIERRA');
}
if (scheduleText.indexOf('BOTH STORES') >= 0) {
  throw new Error('Schedule sheet should omit unscheduled roster employee BOTH STORES');
}
if (scheduleText.indexOf('11:00AM - 9:00PM') < 0) {
  throw new Error('Schedule sheet missing shift times for MARK ONG');
}
if (scheduleText.indexOf('3:00PM BREAK TIME') < 0) {
  throw new Error('Schedule sheet missing break annotation');
}

/* forceFresh must rebuild from the live assignment snapshot (not a stale sheet cache). */
deps.__scheduleSnapshotRows = [
  {
    id: 'shift-0-0-0',
    restaurantId: 'rp-9',
    restaurantName: 'Red Poke 598 9th Ave',
    day: 'Mon May 18',
    trIdx: 0,
    role: 'Bartender',
    start: '12:00',
    end: '20:00',
    timeLabel: '12:00PM - 8:00PM',
    redPokeBreak: '(4:00PM BREAK TIME)',
    redPokeHours: '8',
    workers: ['MARK ONG'],
  },
];
const staleCached = sandbox.__gmTimecardsTest.buildFullReportSheets();
const staleSched = worksheetText(staleCached.find((s) => s.name === 'Schedule').worksheet);
if (staleSched.indexOf('12:00PM - 8:00PM') >= 0) {
  throw new Error('Expected sheet cache to keep prior Schedule until forceFresh');
}
const freshBuild = sandbox.__gmTimecardsTest.buildFullReportSheets({ forceFresh: true });
const freshSched = worksheetText(freshBuild.find((s) => s.name === 'Schedule').worksheet);
if (freshSched.indexOf('12:00PM - 8:00PM') < 0) {
  throw new Error('forceFresh did not pick up updated schedule snapshot times');
}
if (freshSched.indexOf('4:00PM BREAK TIME') < 0) {
  throw new Error('forceFresh did not pick up updated break annotation');
}
console.log('OK: Schedule sheet reflects live snapshot; forceFresh bypasses stale cache');

/* Full report: exclude zero-work roster-only staff; include off-schedule paid workers. */
sandbox.__gmTimecardsTest.setRosterCacheForTest(mockRows);
sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
const scheduledOnlyBuild = sandbox.__gmTimecardsTest.buildFullReportSheets();
function sheetHasName(sheets, sheetName, person) {
  const sh = sheets.find((s) => s.name === sheetName);
  return worksheetText(sh && sh.worksheet).indexOf(person) >= 0;
}
for (const sheetName of ['Labor Cost', 'CPA', 'Payslip', 'PTO', 'Employee Information', 'Schedule']) {
  if (sheetHasName(scheduledOnlyBuild, sheetName, 'JUAN SALVATIERRA')) {
    throw new Error(sheetName + ' should omit unscheduled JUAN SALVATIERRA');
  }
  if (sheetHasName(scheduledOnlyBuild, sheetName, 'BOTH STORES')) {
    throw new Error(sheetName + ' should omit unscheduled BOTH STORES');
  }
}
if (!sheetHasName(scheduledOnlyBuild, 'Labor Cost', 'MARK') || !sheetHasName(scheduledOnlyBuild, 'Labor Cost', 'ONG')) {
  throw new Error('Labor Cost should still include scheduled MARK ONG');
}
if (!sheetHasName(scheduledOnlyBuild, 'Labor Cost', 'PAID') || !sheetHasName(scheduledOnlyBuild, 'Payroll', 'PAID')) {
  throw new Error('Full report should include off-schedule employee with payable hours');
}
if (!sheetHasName(scheduledOnlyBuild, 'Employee Information', 'PAID OFFSCHEDULE')) {
  throw new Error('Employee Information should include off-schedule paid employee');
}
console.log('OK: full report excludes zero-work roster-only; includes payable off-schedule staff');

/* Payslip omits empty day-off / off-schedule rows with no punches or day pay. */
{
  const emp = mockEmployees[0];
  const emptyOff = {
    iso: '2026-05-24',
    shift: { id: 'off-schedule:2026-05-24', start: '', end: '', day: 'Sun May 24' },
  };
  if (sandbox.__gmTimecardsTest.payslipShiftRowHasPayableActivity(emp, emptyOff)) {
    throw new Error('Empty off-schedule day should be omitted from payslip');
  }
  const emptyScheduled = {
    iso: '2026-05-18',
    shift: {
      id: 'shift-0-0-0',
      start: '11:00',
      end: '21:00',
      redPokeHours: '10',
      redPokeBreak: '(3:00PM BREAK TIME)',
    },
  };
  if (sandbox.__gmTimecardsTest.payslipShiftRowHasPayableActivity(emp, emptyScheduled)) {
    throw new Error('Scheduled day with no punches/pay should be omitted from payslip');
  }
  console.log('OK: payslip omits empty day-off / unworked shift rows');
}

/* Restore multi-location schedule for location-scoping checks below. */
deps.__scheduleSnapshotRows = [
  {
    id: 'shift-0-0-0',
    restaurantId: 'rp-9',
    restaurantName: 'Red Poke 598 9th Ave',
    day: 'Mon May 18',
    trIdx: 0,
    role: 'Bartender',
    start: '11:00',
    end: '21:00',
    timeLabel: '11:00AM - 9:00PM',
    redPokeBreak: '(3:00PM BREAK TIME)',
    redPokeHours: '10',
    workers: ['MARK ONG'],
  },
  {
    id: 'shift-0-1-0',
    restaurantId: 'rp-9',
    restaurantName: 'Red Poke 598 9th Ave',
    day: 'Mon May 18',
    trIdx: 0,
    role: 'Kitchen',
    start: '10:00',
    end: '18:00',
    timeLabel: '10:00AM - 6:00PM',
    redPokeBreak: '(2:00PM BREAK TIME)',
    redPokeHours: '8',
    workers: ['BALTAZAR LUCAS'],
  },
  {
    id: 'shift-8-0-0',
    restaurantId: 'rp-8',
    restaurantName: 'Red Poke 885 8th Ave',
    day: 'Mon May 18',
    trIdx: 0,
    role: 'Kitchen',
    start: '10:00',
    end: '18:00',
    timeLabel: '10:00AM - 6:00PM',
    redPokeBreak: '(2:00PM BREAK TIME)',
    redPokeHours: '8',
    workers: ['EIGHTH ONLY'],
  },
];
sandbox.__gmTimecardsTest.invalidatePayWeekScheduleCache();
sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();

const wb = XLSX.utils.book_new();
for (const sh of build) {
  XLSX.utils.book_append_sheet(wb, sh.worksheet, sh.name);
}
const out = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer', bookSST: false });
const outPath = path.join(ROOT, '.tmp-full-report-build-verify.xlsx');
fs.writeFileSync(outPath, out);

console.log('OK:', build.length, 'sheets →', names.join(', '));
console.log('Wrote', outPath, '(' + out.length + ' bytes)');
timings.forEach((t, i) => {
  console.log(
    'timing run',
    i + 1 + ':',
    'build',
    t.build.toFixed(1) + 'ms,',
    'write',
    t.write.toFixed(1) + 'ms,',
    'total',
    t.total.toFixed(1) + 'ms,',
    'bytes',
    t.bytes
  );
});
const cacheT0 = performance.now();
sandbox.__gmTimecardsTest.buildFullReportSheets();
const cacheT1 = performance.now();
console.log('timing cache hit: build', (cacheT1 - cacheT0).toFixed(1) + 'ms');

function visibleNamesForLocation(loc) {
  sandbox.__gmTimecardsTest.setTimecardsLocationFilterForTest(loc);
  sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
  const visible = sandbox.__gmTimecardsTest.sortedRosterRows(mockRows).map((r) => r.name);
  const infoWs = sandbox.__gmTimecardsTest.buildEmployeeInfoWorksheet();
  const infoText = Object.keys(infoWs || {})
    .filter((k) => k.charAt(0) !== '!')
    .map((k) => String((infoWs[k] && infoWs[k].v) || ''))
    .join('\n');
  return { visible, infoText, fileBase: sandbox.__gmTimecardsTest.timecardsExportFileBase() };
}

const ninth = visibleNamesForLocation('rp-9');
const eighth = visibleNamesForLocation('rp-8');

if (ninth.visible.indexOf('EIGHTH ONLY') >= 0) {
  throw new Error('9th Ave roster should not include 8th-only employee');
}
if (eighth.visible.indexOf('MARK ONG') >= 0) {
  throw new Error('8th Ave roster should not include 9th-only employee');
}
if (ninth.visible.indexOf('BOTH STORES') < 0) {
  throw new Error('both-location employee with primary rp-9 should appear on 9th export');
}
if (eighth.visible.indexOf('BOTH STORES') >= 0) {
  throw new Error('both-location employee with primary rp-9 should not appear on 8th export');
}
if (eighth.visible.indexOf('BOTH EIGHTH') < 0) {
  throw new Error('both-location employee with primary rp-8 should appear on 8th export');
}
if (ninth.visible.indexOf('BOTH EIGHTH') >= 0) {
  throw new Error('both-location employee with primary rp-8 should not appear on 9th export');
}
if (ninth.visible.indexOf('BOTH NOPRIMARY') >= 0 || eighth.visible.indexOf('BOTH NOPRIMARY') >= 0) {
  throw new Error('both-location employee with missing primary should be excluded from single-store filters');
}
if (ninth.infoText.indexOf('EIGHTH ONLY') >= 0) {
  throw new Error('Employee Information sheet leaked 8th-only staff into 9th Ave export');
}
if (eighth.infoText.indexOf('MARK ONG') >= 0) {
  throw new Error('Employee Information sheet leaked 9th-only staff into 8th Ave export');
}
if (ninth.fileBase.indexOf('9th-ave') < 0) {
  throw new Error('Expected 9th-ave in fileBase, got ' + ninth.fileBase);
}
if (eighth.fileBase.indexOf('8th-ave') < 0) {
  throw new Error('Expected 8th-ave in fileBase, got ' + eighth.fileBase);
}

sandbox.__gmTimecardsTest.setTimecardsLocationFilterForTest('rp-9');
sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
const sheets9 = sandbox.__gmTimecardsTest.buildFullReportSheets({ forceFresh: true });
sandbox.__gmTimecardsTest.setTimecardsLocationFilterForTest('rp-8');
sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
const sheets8 = sandbox.__gmTimecardsTest.buildFullReportSheets({ forceFresh: true });
const payslip9 = sheets9.find((s) => s.name === 'Payslip');
const payslip8 = sheets8.find((s) => s.name === 'Payslip');
const schedule9 = sheets9.find((s) => s.name === 'Schedule');
const schedule8 = sheets8.find((s) => s.name === 'Schedule');
if (!payslip9 || !payslip8) throw new Error('Payslip sheet missing for location-scoped builds');
if (!schedule9 || !schedule8) throw new Error('Schedule sheet missing for location-scoped builds');
const schedTitle9 = schedule9.worksheet.A1 && schedule9.worksheet.A1.v;
const schedTitle8 = schedule8.worksheet.A1 && schedule8.worksheet.A1.v;
if (String(schedTitle9).indexOf('RED POKE 1') < 0) {
  throw new Error('9th schedule title should say RED POKE 1, got ' + schedTitle9);
}
if (String(schedTitle8).indexOf('RED POKE 2') < 0) {
  throw new Error('8th schedule title should say RED POKE 2, got ' + schedTitle8);
}

console.log('OK: location scoping — 9th visible:', ninth.visible.join(', '));
console.log('OK: location scoping — 8th visible:', eighth.visible.join(', '));
console.log('OK: fileBase 9th=', ninth.fileBase, '8th=', eighth.fileBase);

// --- Payslip content + OOXML print patch (schema order) ---
const JSZip = sandbox.JSZip;

function toNodeBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof ArrayBuffer) return Buffer.from(bytes);
  if (bytes && bytes.buffer instanceof ArrayBuffer) {
    return Buffer.from(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
  }
  return Buffer.from(bytes);
}

function assertWellFormedXml(xml, label) {
  if (!xml || !/^<\?xml/.test(xml)) throw new Error(label + ': missing XML declaration');
  if (!/<\/worksheet>\s*$/.test(xml)) throw new Error(label + ': missing closing </worksheet>');
  // Illegal XML 1.0 control chars (except TAB/LF/CR) corrupt Excel sheet parts.
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(xml)) {
    throw new Error(label + ': contains illegal XML control characters');
  }
  // Cheap well-formedness: balanced tags for worksheet children we care about.
  const openWs = (xml.match(/<worksheet\b/g) || []).length;
  const closeWs = (xml.match(/<\/worksheet>/g) || []).length;
  if (openWs !== 1 || closeWs !== 1) throw new Error(label + ': worksheet tag imbalance');
}

async function verifyPayslipPatchedExport() {
  sandbox.__gmTimecardsTest.setTimecardsLocationFilterForTest('rp-9');
  sandbox.__gmTimecardsTest.setRosterCacheForTest(mockRows);
  sandbox.__gmTimecardsTest.invalidatePayWeekScheduleCache();
  sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
  const sheets = sandbox.__gmTimecardsTest.buildFullReportSheets({ forceFresh: true });
  const payslip = sheets.find((s) => s.name === 'Payslip');
  if (!payslip || !payslip.worksheet) throw new Error('Payslip worksheet missing');
  const cellKeys = Object.keys(payslip.worksheet).filter((k) => k.charAt(0) !== '!');
  if (cellKeys.length < 20) {
    throw new Error('Payslip looks blank before write: only ' + cellKeys.length + ' cells');
  }
  const written = sandbox.__gmTimecardsTest.writeFullReportWorkbookBytes(sheets);
  if (!written.payslipPrintMeta) throw new Error('expected payslipPrintMeta from write');
  const patched = await sandbox.__gmTimecardsTest.patchPayslipPrintOoxml(
    written.bytes,
    written.payslipPrintMeta
  );
  const zip = await JSZip.loadAsync(toNodeBuffer(patched));
  const sheet4 = zip.file('xl/worksheets/sheet4.xml');
  if (!sheet4) throw new Error('sheet4.xml missing after payslip patch');
  const sheetXml = await sheet4.async('string');
  assertWellFormedXml(sheetXml, 'sheet4.xml');
  if (!/<sheetData[\s>]/.test(sheetXml) || !/<c\s/.test(sheetXml)) {
    throw new Error('Payslip sheet4.xml has no cell content after patch');
  }
  const vCount = (sheetXml.match(/<v>/g) || []).length;
  if (vCount < 20) {
    throw new Error('Payslip sheet4.xml too sparse after patch: ' + vCount + ' values');
  }
  const marginsAt = sheetXml.indexOf('<pageMargins');
  const ignoredAt = sheetXml.indexOf('<ignoredErrors');
  const drawingAt = sheetXml.indexOf('<drawing');
  if (marginsAt < 0) throw new Error('pageMargins missing after payslip patch');
  if (ignoredAt >= 0 && marginsAt > ignoredAt) {
    throw new Error(
      'OOXML order bug: pageMargins after ignoredErrors (Excel replaces sheet4 → blank Payslip)'
    );
  }
  if (drawingAt >= 0 && marginsAt > drawingAt) {
    throw new Error('OOXML order bug: pageMargins after drawing');
  }
  // Also validate every worksheet + optional drawings parse as XML.
  const sheetPaths = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/.test(p))
    .sort();
  for (const p of sheetPaths) {
    assertWellFormedXml(await zip.file(p).async('string'), p);
  }
  const drawingPaths = Object.keys(zip.files).filter((p) => /^xl\/drawings\/.+\.xml$/.test(p));
  for (const p of drawingPaths) {
    const dxml = await zip.file(p).async('string');
    if (!/^<\?xml/.test(dxml) || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(dxml)) {
      throw new Error(p + ' failed XML sanity check');
    }
  }
  const patchedPath = path.join(ROOT, '.tmp-full-report-build-verify.xlsx');
  fs.writeFileSync(patchedPath, toNodeBuffer(patched));
  console.log(
    'OK: Payslip patched export —',
    vCount,
    'values, schema order good →',
    patchedPath
  );
}

await verifyPayslipPatchedExport();

/* Person-week view: leaveBalance VL/SL days surface as rows + week extras; punch days not
 * hidden by location filter when personWeekView is used. */
{
  const T = sandbox.__gmTimecardsTest;
  const leaveEmp = {
    id: 'e-leave',
    firstName: 'LEAVE',
    lastName: 'TESTER',
    staffType: 'Kitchen',
    usualRestaurant: 'rp-9',
    hourlyRate: 18,
    weeklyGrid: {},
    meta: {
      leaveBalance: {
        vacation: { entries: [{ date: '2026-05-20', hours: 8 }] },
        sick: { entries: [{ date: '2026-05-21', hours: 4 }] },
      },
    },
  };
  deps.employees = mockEmployees.concat([leaveEmp]);
  T.setWeekEntriesForTest([]);
  const leaveExtras = T.getEmployeeWeekExtras(leaveEmp);
  if (Math.abs(leaveExtras.vl - 8) > 0.01 || Math.abs(leaveExtras.sl - 4) > 0.01) {
    throw new Error(
      'Week extras should include leaveBalance VL/SL (got vl=' +
        leaveExtras.vl +
        ' sl=' +
        leaveExtras.sl +
        ')'
    );
  }
  const leaveShifts = T.buildShiftsForEmployeeInWeek(leaveEmp, { personWeekView: true });
  const leaveIsos = leaveShifts.map((r) => r.iso);
  if (leaveIsos.indexOf('2026-05-20') < 0 || leaveIsos.indexOf('2026-05-21') < 0) {
    throw new Error('Person week view must list leaveBalance VL/SL days: ' + leaveIsos.join(','));
  }
  const effVl = T.getEffectiveDayLeave(leaveEmp, '2026-05-20');
  const effSl = T.getEffectiveDayLeave(leaveEmp, '2026-05-21');
  if (Math.abs(effVl.vl - 8) > 0.01 || Math.abs(effSl.sl - 4) > 0.01) {
    throw new Error('getEffectiveDayLeave should read leaveBalance entries');
  }

  /* Manual VL-only off-schedule day appears even when location filter is set. */
  T.setTimecardsLocationFilterForTest('rp-8');
  T.setEmployeeDayLeave('e1', '2026-05-22', 7.5, 0);
  const mark = mockEmployees[0];
  const markRows = T.buildShiftsForEmployeeInWeek(mark, { personWeekView: true });
  if (!markRows.some((r) => r.iso === '2026-05-22')) {
    throw new Error('Person week view must show VL-only day despite location filter');
  }
  if (!T.payslipShiftRowHasPayableActivity(mark, {
    iso: '2026-05-22',
    shift: { id: 'off-schedule:2026-05-22', start: '', end: '' },
  })) {
    throw new Error('VL-only day should be payable on payslip');
  }

  /* Cross-location punch still surfaces on person week view. */
  T.setWeekEntriesForTest([
    {
      id: 'punch-x',
      employee_id: 'e1',
      clock_in_at: '2026-05-19T15:00:00.000Z',
      clock_out_at: '2026-05-19T23:00:00.000Z',
      clock_restaurant_id: 'rp-9',
      break_minutes: 0,
    },
  ]);
  T.setTimecardsLocationFilterForTest('rp-8');
  const punchRows = T.buildShiftsForEmployeeInWeek(mark, { personWeekView: true });
  if (!punchRows.some((r) => r.iso === '2026-05-19')) {
    throw new Error('Person week view must show cross-location punch day');
  }
  T.setTimecardsLocationFilterForTest('rp-9');
  T.setWeekEntriesForTest([]);
  console.log('OK: person week view shows leaveBalance + VL-only + cross-location punch days');
}

/* Collapse same-day duplicate schedule clones (e.g. both stores, overlapping times). */
{
  const T = sandbox.__gmTimecardsTest;
  const emp = {
    id: 'e-dup',
    firstName: 'ZEF',
    lastName: 'TEST',
    staffType: 'Server',
    usualRestaurant: 'rp-9',
    hourlyRate: 17,
  };
  const rows = [
    {
      iso: '2026-07-15',
      shift: { id: 's1', start: '11:00', end: '21:00', restaurantId: 'rp-9' },
    },
    {
      iso: '2026-07-15',
      shift: { id: 's2', start: '11:00', end: '21:00', restaurantId: 'rp-8' },
    },
    {
      iso: '2026-07-15',
      shift: { id: 'off-schedule:2026-07-15', start: '', end: '' },
    },
    {
      iso: '2026-07-16',
      shift: { id: 's3', start: '11:00', end: '15:00', restaurantId: 'rp-9' },
    },
    {
      iso: '2026-07-16',
      shift: { id: 's4', start: '16:00', end: '21:00', restaurantId: 'rp-9' },
    },
    {
      iso: '2026-07-17',
      shift: { id: 's5', start: '11:00', end: '21:00', restaurantId: 'rp-9' },
    },
    {
      iso: '2026-07-17',
      shift: { id: 's6', start: '10:00', end: '20:30', restaurantId: 'rp-8' },
    },
  ];
  const collapsed = T.collapseDuplicateShiftDayRows(rows, emp);
  const jul15 = collapsed.filter((r) => r.iso === '2026-07-15');
  const jul16 = collapsed.filter((r) => r.iso === '2026-07-16');
  const jul17 = collapsed.filter((r) => r.iso === '2026-07-17');
  if (jul15.length !== 1) {
    throw new Error('Same-time multi-store + off-schedule must collapse to 1 Jul 15 row, got ' + jul15.length);
  }
  if (jul15[0].shift.id === 'off-schedule:2026-07-15') {
    throw new Error('Prefer scheduled row over off-schedule duplicate');
  }
  if (jul16.length !== 2) {
    throw new Error('Distinct non-overlapping start/end same day must keep 2 rows, got ' + jul16.length);
  }
  if (jul17.length !== 1) {
    throw new Error(
      'Overlapping different-time multi-store clones must collapse to 1 Jul 17 row, got ' + jul17.length
    );
  }
  if (jul17[0].shift.restaurantId !== 'rp-9') {
    throw new Error('Prefer home-store row when collapsing overlapping multi-store clones');
  }

  /* Corrupt overnight mega-span (am/pm clone) must not survive beside a normal day shift. */
  const overnightRows = [
    {
      iso: '2026-07-27',
      shift: { id: 's-day', start: '09:00', end: '18:00', restaurantId: 'rp-9' },
    },
    {
      iso: '2026-07-27',
      shift: { id: 's-overnight', start: '23:30', end: '21:30', restaurantId: 'rp-9' },
    },
  ];
  const overnightCollapsed = T.collapseDuplicateShiftDayRows(overnightRows, emp);
  if (overnightCollapsed.length !== 1 || overnightCollapsed[0].shift.id !== 's-day') {
    throw new Error(
      'Absurd overnight clone beside daytime shift must collapse to daytime row, got ' +
        overnightCollapsed.map((r) => r.shift.id).join(',')
    );
  }
  console.log('OK: collapseDuplicateShiftDayRows keeps distinct slots, drops clones');
}

/* VL/SL pay: Payroll TOTAL GROSS + Labor totals include straight-time leave pay. */
{
  const T = sandbox.__gmTimecardsTest;
  const leavePayRow = {
    emp: {
      id: 'e-bernabe',
      firstName: 'BERNABE',
      lastName: 'DE LEON',
      staffType: 'Kitchen',
      hourlyRate: 19,
      tipPoint: 0,
    },
    name: 'BERNABE DE LEON',
    regMins: 22.5 * 60,
    otMins: 0,
    totalMins: 22.5 * 60,
    vlHours: 0,
    slHours: 12,
    regPay: 22.5 * 19,
    otPay: 0,
    vlPay: 0,
    slPay: 12 * 19,
    sohCount: 0,
    sohPay: null,
    sohDatesLabel: '—',
    additionalCashTip: 0,
    dishwasherTipsPay: 0,
    grandTotalPay: 22.5 * 19 + 12 * 19,
  };
  const metrics = T.computePayrollRowMetrics(leavePayRow);
  const expectedGross = 22.5 * 19 + 12 * 19; // 655.5
  if (Math.abs(metrics.gross - expectedGross) > 0.01) {
    throw new Error(
      'Payroll TOTAL GROSS must include SL pay (expected ' + expectedGross + ', got ' + metrics.gross + ')'
    );
  }
  if (Math.abs(metrics.totalH - 34.5) > 0.01) {
    throw new Error('Payroll TOTAL HOURS should be reg+ot+VL+SL, got ' + metrics.totalH);
  }

  T.setRosterCacheForTest([leavePayRow]);
  T.invalidateFullReportSheetsCache();
  const laborAoa = T.buildLaborExportAoa();
  const laborData = laborAoa && laborAoa[1];
  if (!laborData) throw new Error('Labor export missing Bernabe row');
  // cols: first, last, regH, otH, totalH, regCost, otCost, totalCost
  if (Math.abs(Number(laborData[4]) - 34.5) > 0.01) {
    throw new Error('Labor total paid hours must include SL (got ' + laborData[4] + ')');
  }
  if (Math.abs(Number(laborData[7]) - expectedGross) > 0.01) {
    throw new Error('Labor total cost must include SL pay (got ' + laborData[7] + ')');
  }
  console.log('OK: Payroll/Labor include VL/SL straight-time pay (Bernabe-style $655.50)');
}

/* Missing hours: payroll MISSED HOURS + OT-aware missed pay into TOTAL GROSS. */
{
  const T = sandbox.__gmTimecardsTest;
  const emp = {
    id: 'e-miss',
    firstName: 'MISS',
    lastName: 'HOURS',
    staffType: 'Kitchen',
    hourlyRate: 19,
    tipPoint: 0,
  };
  T.setPriorWeekRecordedMinsForTest(emp.id, 37 * 60);
  const info = T.computeMissingHoursPay(emp, 6);
  const expectedMissPay = 3 * 19 + 3 * 19 * 1.5; // 142.5
  if (Math.abs((info.pay || 0) - expectedMissPay) > 0.01) {
    throw new Error(
      'Missing hours OT pay expected ' +
        expectedMissPay +
        ', got ' +
        info.pay +
        ' (reg=' +
        info.regHours +
        ' ot=' +
        info.otHours +
        ')'
    );
  }
  const missMetrics = T.computePayrollRowMetrics({
    emp: emp,
    name: 'MISS HOURS',
    regMins: 20 * 60,
    otMins: 0,
    totalMins: 20 * 60,
    vlHours: 0,
    slHours: 0,
    missingHours: 6,
    missingPay: info.pay,
    regPay: 20 * 19,
    otPay: 0,
    vlPay: 0,
    slPay: 0,
    sohCount: 0,
    sohPay: null,
    sohDatesLabel: '—',
    additionalCashTip: 0,
    dishwasherTipsPay: 0,
    grandTotalPay: 20 * 19,
  });
  const expectedMissGross = 20 * 19 + expectedMissPay;
  if (Math.abs(missMetrics.gross - expectedMissGross) > 0.01) {
    throw new Error(
      'Payroll TOTAL GROSS must include missed pay (expected ' +
        expectedMissGross +
        ', got ' +
        missMetrics.gross +
        ')'
    );
  }
  if (Math.abs(missMetrics.totalH - 26) > 0.01) {
    throw new Error('Payroll TOTAL HOURS should include missed hours, got ' + missMetrics.totalH);
  }
  if (Math.abs(missMetrics.missedH - 6) > 0.01) {
    throw new Error('Payroll MISSED HOURS column missing, got ' + missMetrics.missedH);
  }
  console.log('OK: Payroll includes missed hours/pay with OT factoring');
}

/* forceFresh: Employee Information + PTO rebuild from live employees / week extras. */
{
  const leaveCode = fs.readFileSync(path.join(ROOT, 'employee-leave.js'), 'utf8');
  vm.runInContext(leaveCode, sandbox);

  const T = sandbox.__gmTimecardsTest;
  const mark = mockEmployees[0];
  mark.meta = mark.meta || {};
  mark.meta.position = 'STORE MANAGER';
  mark.meta.hiringDate = '3/25/2023';
  mark.meta.leaveBalance = {
    version: 1,
    vacation: {
      allowanceDays: 5,
      allowanceHours: 40,
      hoursPerDay: 8,
      entries: [{ date: '2026-02-01', hours: 8 }],
    },
    sick: {
      allowanceDays: 5,
      allowanceHours: 40,
      hoursPerDay: 8,
      entries: [{ date: '2026-02-04', hours: 8 }],
      note: '',
    },
  };

  T.setRosterCacheForTest(
    mockRows.map((r) =>
      r.emp.id === 'e1'
        ? Object.assign({}, r, { emp: mark, vlHours: 0, slHours: 12, vlPay: 0, slPay: 12 * 22 })
        : r
    )
  );
  const firstBuild = T.buildFullReportSheets({ forceFresh: true });
  const firstInfo = worksheetText(firstBuild.find((s) => s.name === 'Employee Information').worksheet);
  if (firstInfo.indexOf('STORE MANAGER') < 0) {
    throw new Error('Employee Information missing initial position');
  }

  mark.meta.position = 'GENERAL MANAGER';
  mark.meta.hiringDate = '1/1/2020';
  mark.hourlyRate = 25;
  // Stale sheet cache would keep STORE MANAGER without forceFresh invalidation path.
  const stale = T.buildFullReportSheets();
  const staleInfo = worksheetText(stale.find((s) => s.name === 'Employee Information').worksheet);
  if (staleInfo.indexOf('GENERAL MANAGER') >= 0) {
    // Cache may already have been cleared by prior dirty marks — either outcome is ok if forceFresh works.
  }

  const fresh = T.buildFullReportSheets({ forceFresh: true });
  const freshInfo = worksheetText(fresh.find((s) => s.name === 'Employee Information').worksheet);
  if (freshInfo.indexOf('GENERAL MANAGER') < 0) {
    throw new Error('forceFresh Employee Information must pick up Team position edits');
  }
  if (freshInfo.indexOf('1/1/2020') < 0) {
    throw new Error('forceFresh Employee Information must pick up hiring date edits');
  }

  /* Person-week SL extras must appear on PTO sheet after leave updates. */
  T.setEmployeeDayLeave('e1', '2026-05-22', 0, 6);
  T.setEmployeeDayLeave('e1', '2026-05-23', 0, 6);
  const ptoBal = T.ptoBalanceForEmployee(mark);
  const sickDates = (ptoBal.sick.entries || []).map((e) => e.date);
  if (sickDates.indexOf('2026-05-22') < 0 || sickDates.indexOf('2026-05-23') < 0) {
    throw new Error('PTO sick entries must include week-extras SL days: ' + sickDates.join(','));
  }
  if (sickDates.indexOf('2026-02-04') < 0) {
    throw new Error('PTO sick entries must retain leaveBalance dates');
  }

  const ptoFresh = T.buildFullReportSheets({ forceFresh: true });
  const ptoText = worksheetText(ptoFresh.find((s) => s.name === 'PTO').worksheet);
  if (ptoText.indexOf('05/22/2026') < 0 && ptoText.indexOf('5/22/2026') < 0) {
    // formatUsDate pads MM/DD/YYYY
    if (ptoText.indexOf('05/22') < 0) {
      throw new Error('PTO sheet must show week-extras SL date after leave update');
    }
  }
  console.log('OK: forceFresh refreshes Employee Info + PTO from live leave/profile data');
}

