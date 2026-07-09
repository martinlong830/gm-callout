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
  shiftRowIncludesWorker() {
    return false;
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
  buildScheduleSnapshotForPayWeek() {
    return [];
  },
  redPokeShiftTimeLabel() {
    return '—';
  },
  redPokeShiftHoursDecimal(start, end) {
    if (!start || !end) return '0';
    return '8';
  },
  restaurantsList: [
    { id: 'rp-9', name: 'Red Poke 598 9th Ave' },
    { id: 'rp-8', name: 'Red Poke 885 8th Ave' },
  ],
};

const sandbox = {
  XLSX,
  localStorage,
  document,
  console,
  setTimeout,
  clearTimeout,
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
