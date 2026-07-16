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
    meta: { position: 'SERVICE REP' },
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

const mockRows = mockEmployees.map((emp) => ({
  emp,
  name: deps.employeeDisplayName(emp),
  regMins: 2400,
  otMins: 0,
  vlHours: 0,
  slHours: 0,
  regPay: (emp.hourlyRate || 15) * 40,
  otPay: 0,
  sohCount: 0,
  sohDatesLabel: '—',
  sohPay: null,
  grandTotalPay: (emp.hourlyRate || 15) * 40,
  dishwasherTipsPay: 0,
  additionalCashTip: 0,
}));

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

/* Full report must exclude staff not on main schedule rows this week (Mike Clarino case). */
sandbox.__gmTimecardsTest.invalidateFullReportSheetsCache();
const scheduledOnlyBuild = sandbox.__gmTimecardsTest.buildFullReportSheets({ forceFresh: true });
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
console.log('OK: full report excludes employees not on main schedule rows');

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
if (ninth.visible.indexOf('BOTH STORES') < 0 || eighth.visible.indexOf('BOTH STORES') < 0) {
  throw new Error('both-location employee should appear on 9th and 8th exports');
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

