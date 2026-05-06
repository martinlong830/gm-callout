/**
 * Ported schedule math from `app.js` (rebuildSchedule + calendar cell logic).
 * No DOM / localStorage — pure inputs for React Native.
 */
import type {
  AssignmentStore,
  DraftGrid,
  EmployeeLite,
  Restaurant,
  RoleKey,
  ScheduleRow,
  WeekMeta,
  WeekdayKey,
} from './types';

export const SCHEDULE_VIEW_WEEK_COUNT = 3;
export const WEEKDAY_KEYS: WeekdayKey[] = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const SCHEDULE_GRID_ROLE_ORDER: RoleKey[] = ['Bartender', 'Kitchen', 'Server'];

const FULL_WEEKDAY_NAMES_UPPER = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
];

export const STAFF_TYPE_LABELS: Record<RoleKey, string> = {
  Kitchen: 'Back of the House',
  Bartender: 'Front of the House',
  Server: 'Delivery/Dishwasher',
};

const STAFF_ROLE_CLASS: Record<RoleKey, string> = {
  Kitchen: 'role-kitchen',
  Bartender: 'role-bartender',
  Server: 'role-server',
};

export const ROLE_DEFS: { role: RoleKey; roleClass: string; groupLabel: string }[] = [
  { role: 'Kitchen', roleClass: STAFF_ROLE_CLASS.Kitchen, groupLabel: STAFF_TYPE_LABELS.Kitchen },
  { role: 'Bartender', roleClass: STAFF_ROLE_CLASS.Bartender, groupLabel: STAFF_TYPE_LABELS.Bartender },
  { role: 'Server', roleClass: STAFF_ROLE_CLASS.Server, groupLabel: STAFF_TYPE_LABELS.Server },
];

export const DEFAULT_DRAFT_SCHEDULE_ROWS: DraftGrid = {
  Bartender: [
    [
      ['10:00', '19:30'],
      ['10:00', '19:30'],
      ['10:00', '19:30'],
      ['10:00', '19:30'],
      ['09:00', '18:00'],
      ['10:30', '20:30'],
      ['10:30', '20:30'],
    ],
    [
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      ['10:30', '16:00'],
      ['10:30', '20:30'],
      ['12:00', '21:30'],
      ['12:00', '21:30'],
    ],
    [
      ['11:30', '21:30'],
      ['11:30', '21:30'],
      ['11:30', '21:30'],
      ['11:00', '20:30'],
      ['11:30', '21:30'],
      null,
      null,
    ],
    [null, null, null, ['12:00', '21:30'], null, null, null],
  ],
  Kitchen: [
    [
      ['08:00', '17:00'],
      ['08:00', '17:00'],
      ['08:00', '17:00'],
      ['08:00', '17:00'],
      ['08:00', '15:00'],
      ['09:00', '19:00'],
      ['09:00', '20:00'],
    ],
    [
      ['08:00', '13:00'],
      ['08:00', '13:00'],
      ['08:00', '13:00'],
      ['08:00', '13:00'],
      ['08:00', '13:00'],
      ['10:00', '22:00'],
      ['10:00', '22:00'],
    ],
    [
      ['09:00', '16:00'],
      ['09:00', '16:00'],
      ['09:00', '16:00'],
      ['09:00', '16:00'],
      ['09:00', '16:00'],
      null,
      null,
    ],
    [
      ['11:00', '20:00'],
      ['11:00', '20:00'],
      ['11:00', '20:00'],
      ['11:00', '20:00'],
      ['10:00', '20:00'],
      null,
      null,
    ],
    [
      ['16:00', '22:00'],
      ['16:00', '22:00'],
      ['16:00', '22:00'],
      ['12:00', '22:00'],
      ['16:00', '22:00'],
      null,
      null,
    ],
  ],
  Server: [
    [
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      ['10:00', '18:00'],
      ['10:00', '22:00'],
      ['10:00', '16:00'],
    ],
    [
      ['11:30', '22:00'],
      ['11:30', '22:00'],
      ['11:30', '22:00'],
      ['11:30', '22:00'],
      ['11:30', '22:00'],
      null,
      ['15:00', '22:00'],
    ],
  ],
};

export function defaultRestaurants(): Restaurant[] {
  return [{ id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 598 9th Ave' }];
}

export function redPokeShiftTimeLabel(start: string, end: string): string {
  function parts(t: string) {
    const p = String(t || '').split(':');
    return { h: parseInt(p[0], 10) || 0, m: parseInt(p[1], 10) || 0 };
  }
  function fmt(h: number, m: number) {
    const pm = h >= 12;
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    const hh = String(h12).padStart(2, '0');
    return hh + ':' + String(m).padStart(2, '0') + (pm ? 'pm' : 'am');
  }
  const s = parts(start);
  const e = parts(end);
  return fmt(s.h, s.m) + '-' + fmt(e.h, e.m);
}

export function redPokeShiftHoursDecimal(start: string, end: string): string {
  function toMin(t: string) {
    const p = String(t || '').split(':');
    return (parseInt(p[0], 10) || 0) * 60 + (parseInt(p[1], 10) || 0);
  }
  let m = toMin(end) - toMin(start);
  if (m <= 0) m += 24 * 60;
  const h = m / 60;
  if (Number.isInteger(h)) return String(h);
  return (Math.round(h * 10) / 10).toFixed(1);
}

export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function redPokeBreakAnnotation(trStart: string, trEnd: string, role: string, dayStr: string): string {
  const seed = hashString(`${trStart}|${trEnd}|${role}|${dayStr}`);
  const opts = [
    '(3:00PM BREAK TIME)',
    '(3:30PM BREAK TIME)',
    '(2:00PM OFFICE)',
    '(NO BREAK TIME)',
    '(4:00PM BREAK TIME)',
    '(4:30PM BREAK TIME)',
    '(3:00PM BREAK TIME)',
  ];
  return opts[seed % opts.length];
}

export function makeTimeSlot(start: string, end: string) {
  const sk = `${start}|${end}`;
  return { start, end, slotKey: sk, label: redPokeShiftTimeLabel(start, end) };
}

function cloneDraftSchedule(obj: DraftGrid): DraftGrid {
  return JSON.parse(JSON.stringify(obj)) as DraftGrid;
}

function normalizeHHMM(val: unknown): string | null {
  if (val == null || val === '') return null;
  const s = String(val).trim();
  const m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!m) return null;
  const h = Math.min(23, parseInt(m[1], 10));
  const mi = Math.min(59, parseInt(m[2], 10));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function normalizeDraftCell(cell: unknown): [string, string] | null {
  if (cell === null || cell === undefined) return null;
  if (!Array.isArray(cell) || cell.length < 2) return null;
  const a = normalizeHHMM(cell[0]);
  const b = normalizeHHMM(cell[1]);
  if (!a || !b) return null;
  return [a, b];
}

function sanitizeDraftRoleRows(
  rows: unknown,
  defaultRows: Array<Array<[string, string] | null>>
): Array<Array<[string, string] | null>> {
  if (!Array.isArray(rows) || !rows.length) {
    return JSON.parse(JSON.stringify(defaultRows)) as Array<Array<[string, string] | null>>;
  }
  const out: Array<Array<[string, string] | null>> = [];
  (rows as unknown[][]).forEach((row) => {
    if (!Array.isArray(row)) return;
    const cells: Array<[string, string] | null> = [];
    for (let di = 0; di < 7; di += 1) {
      cells.push(normalizeDraftCell(row[di]));
    }
    out.push(cells);
  });
  return out.length ? out : JSON.parse(JSON.stringify(defaultRows));
}

export function loadDraftFromTeamState(raw: unknown): DraftGrid {
  const base = cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Record<string, unknown>;
  (['Bartender', 'Kitchen', 'Server'] as RoleKey[]).forEach((role) => {
    const defR = DEFAULT_DRAFT_SCHEDULE_ROWS[role];
    if (!Array.isArray(p[role])) return;
    base[role] = sanitizeDraftRoleRows(p[role], defR as Array<Array<[string, string] | null>>);
  });
  return base;
}

function getDraftRowsForRole(draftRows: DraftGrid, role: RoleKey): Array<Array<[string, string] | null>> {
  const r = draftRows[role];
  if (!r || !r.length) return (DEFAULT_DRAFT_SCHEDULE_ROWS[role] || []) as Array<Array<[string, string] | null>>;
  return r as Array<Array<[string, string] | null>>;
}

export function draftTimeSlotFor(
  draftRows: DraftGrid,
  role: RoleKey,
  weekdayKey: WeekdayKey,
  trIdx: number
): ReturnType<typeof makeTimeSlot> | null {
  const rows = getDraftRowsForRole(draftRows, role);
  if (!rows || !rows[trIdx]) return null;
  const di = WEEKDAY_KEYS.indexOf(weekdayKey);
  if (di < 0) return null;
  const cell = rows[trIdx][di];
  if (!cell) return null;
  return makeTimeSlot(cell[0], cell[1]);
}

export function slotCountForRole(draftRows: DraftGrid, role: RoleKey): number {
  return getDraftRowsForRole(draftRows, role).length;
}

export function getThisMondayDate(): Date {
  const now = new Date();
  const day = now.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

export function buildWeeksFromMonday(numWeeks: number, mondayDate: Date): WeekMeta[] {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const wk = WEEKDAY_KEYS;
  const out: WeekMeta[] = [];
  for (let w = 0; w < numWeeks; w += 1) {
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate() + w * 7 + i);
      const label = `${wk[i]} ${months[d.getMonth()]} ${d.getDate()}`;
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      out.push({
        label,
        weekdayKey: wk[i],
        dayNameUpper: FULL_WEEKDAY_NAMES_UPPER[i],
        iso,
        weekIndex: w,
        dayInWeek: i,
        globalDayIndex: w * 7 + i,
      });
    }
  }
  return out;
}

export function buildAllWeekDayLabels(weekMeta: WeekMeta[]): string[] {
  return weekMeta.map((m) => m.label);
}

export function getVisibleWeekDays(allWeekDays: string[], weekIndex: number): string[] {
  const start = weekIndex * 7;
  return allWeekDays.slice(start, Math.min(start + 7, allWeekDays.length));
}

export function weekdayKeyFromScheduleDay(dayStr: string): WeekdayKey {
  const parts = String(dayStr || '').trim().split(/\s+/);
  return (parts[0] || 'Mon') as WeekdayKey;
}

function employeeDisplayNameLite(emp: EmployeeLite): string {
  const f = (emp.firstName || '').trim();
  const l = (emp.lastName || '').trim();
  return [f, l].filter(Boolean).join(' ') || 'Unnamed';
}

function refreshPools(employees: EmployeeLite[]): Record<RoleKey, string[]> {
  return {
    Kitchen: employees.filter((e) => e.staffType === 'Kitchen').map(employeeDisplayNameLite),
    Bartender: employees.filter((e) => e.staffType === 'Bartender').map(employeeDisplayNameLite),
    Server: employees.filter((e) => e.staffType === 'Server').map(employeeDisplayNameLite),
  };
}

function namesPoolForScheduleRole(
  employees: EmployeeLite[],
  role: RoleKey,
  restaurantId: string
): string[] {
  return employees
    .filter((e) => {
      if (e.staffType !== role) return false;
      const u = e.usualRestaurant || 'both';
      if (u === 'both') return true;
      return u === restaurantId;
    })
    .map(employeeDisplayNameLite);
}

function restaurantUsesDefaultUnassignedSchedule(restaurants: Restaurant[], restaurantId: string): boolean {
  const r = restaurants.find((x) => x.id === restaurantId);
  return !!(r && r.defaultUnassignedSchedule);
}

function uniqueWorkers(pool: string[], seed: number, count: number): string[] {
  if (!pool.length) return [];
  const base = seed % pool.length;
  const workers: string[] = [];
  for (let i = 0; i < pool.length && workers.length < count; i += 1) {
    const idx = (base + i) % pool.length;
    const name = pool[idx];
    if (workers.indexOf(name) === -1) workers.push(name);
  }
  return workers;
}

function normalizeWorkerKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase();
}

export function assignmentShell(restaurants: Restaurant[]): AssignmentStore {
  const o: AssignmentStore = {};
  restaurants.forEach((r) => {
    o[r.id] = {};
  });
  return o;
}

export function mergeRemoteAssignments(
  shell: AssignmentStore,
  parsed: unknown,
  restaurantIds: string[]
): AssignmentStore {
  const next = JSON.parse(JSON.stringify(shell)) as AssignmentStore;
  if (!parsed || typeof parsed !== 'object') return next;
  const p = parsed as Record<string, Record<string, string[]>>;
  restaurantIds.forEach((rid) => {
    if (p[rid] && typeof p[rid] === 'object') next[rid] = p[rid];
  });
  return next;
}

function getCurrentRestaurantAssignments(store: AssignmentStore, restaurantId: string): Record<string, string[]> {
  return store[restaurantId] || {};
}

function applyScheduleAssignmentsMerge(schedule: ScheduleRow[], stored: Record<string, string[]>) {
  schedule.forEach((s) => {
    const arr = stored[s.id];
    if (!arr || !Array.isArray(arr)) return;
    const list = arr.filter(Boolean);
    if (!list.length) return;
    s.workers = list.slice();
    s.worker = s.workers[0];
  });
}

export function buildSchedule(params: {
  allWeekDays: string[];
  draftRows: DraftGrid;
  employees: EmployeeLite[];
  restaurants: Restaurant[];
  currentRestaurantId: string;
  assignmentStore: AssignmentStore;
}): ScheduleRow[] {
  const { allWeekDays, draftRows, employees, restaurants, currentRestaurantId, assignmentStore } = params;
  const pools = refreshPools(employees);
  const forceUnassigned = restaurantUsesDefaultUnassignedSchedule(restaurants, currentRestaurantId);
  const schedule: ScheduleRow[] = [];
  const stored = getCurrentRestaurantAssignments(assignmentStore, currentRestaurantId);

  allWeekDays.forEach((dayStr, globalDayIdx) => {
    const wk = weekdayKeyFromScheduleDay(dayStr);
    const usedToday: Record<string, boolean> = Object.create(null);
    ROLE_DEFS.forEach((rd, roleIdx) => {
      const n = slotCountForRole(draftRows, rd.role);
      for (let trIdx = 0; trIdx < n; trIdx += 1) {
        const tr = draftTimeSlotFor(draftRows, rd.role, wk, trIdx);
        if (!tr) continue;
        const seed = hashString(
          `shift|${dayStr}|${rd.role}|${tr.start}|${tr.end}|${currentRestaurantId}`
        );
        const pool = namesPoolForScheduleRole(employees, rd.role, currentRestaurantId);
        const basePool = pool.length ? pool : pools[rd.role];
        let workers: string[];
        if (forceUnassigned) {
          workers = ['Unassigned'];
        } else {
          const filtered = (basePool || []).filter((name) => {
            if (!name || name === 'Unassigned') return false;
            return !usedToday[normalizeWorkerKey(name)];
          });
          if (filtered.length) {
            workers = uniqueWorkers(filtered, seed, 1);
          } else {
            workers = ['Unassigned'];
          }
          if (!workers.length) workers = ['Unassigned'];
          const chosen = workers[0];
          if (chosen && chosen !== 'Unassigned') {
            usedToday[normalizeWorkerKey(chosen)] = true;
          }
        }
        const shiftId = `shift-${globalDayIdx}-${roleIdx}-${trIdx}`;
        schedule.push({
          id: shiftId,
          day: dayStr,
          trIdx,
          role: rd.role,
          roleClass: rd.roleClass,
          groupLabel: rd.groupLabel,
          start: tr.start,
          end: tr.end,
          slotKey: tr.slotKey,
          timeLabel: redPokeShiftTimeLabel(tr.start, tr.end),
          redPokeBreak: redPokeBreakAnnotation(tr.start, tr.end, rd.role, dayStr),
          redPokeHours: redPokeShiftHoursDecimal(tr.start, tr.end),
          workers,
          worker: workers[0],
        });
      }
    });
  });

  applyScheduleAssignmentsMerge(schedule, stored);
  return schedule;
}

export type CalendarCell =
  | { kind: 'empty' }
  | { kind: 'dayoff'; timeLabel: string; roleLabel: string; dayStr: string }
  | {
      kind: 'shift';
      shift: ScheduleRow;
      workers: string[];
      timeLabel: string;
      breakText: string;
      hours: string;
    };

export type CalendarBodyRow =
  | { kind: 'section'; title: string; variant: 'foh' | 'boh' | 'delivery' }
  | { kind: 'cells'; cells: CalendarCell[] };

export function buildCalendarBody(
  schedule: ScheduleRow[],
  visibleDays: string[],
  draftRows: DraftGrid
): CalendarBodyRow[] {
  const bodyRows: CalendarBodyRow[] = [];
  const colCount = visibleDays.length;

  SCHEDULE_GRID_ROLE_ORDER.forEach((roleKey) => {
    const rd = ROLE_DEFS.find((r) => r.role === roleKey);
    if (!rd) return;
    if (rd.role === 'Bartender') {
      bodyRows.push({ kind: 'section', title: 'FRONT OF THE HOUSE', variant: 'foh' });
    }
    if (rd.role === 'Server') {
      bodyRows.push({ kind: 'section', title: 'DELIVERY/DISHWASHER', variant: 'delivery' });
    }
    if (rd.role === 'Kitchen') {
      bodyRows.push({ kind: 'section', title: 'BACK OF THE HOUSE', variant: 'boh' });
    }

    const slotN = slotCountForRole(draftRows, rd.role);
    for (let trIdx = 0; trIdx < slotN; trIdx += 1) {
      const cells: CalendarCell[] = visibleDays.map((dayStr) => {
        const shift = schedule.find((s) => s.day === dayStr && s.role === rd.role && s.trIdx === trIdx);
        if (!shift) {
          const wkOff = weekdayKeyFromScheduleDay(dayStr);
          const trOff = draftTimeSlotFor(draftRows, rd.role, wkOff, trIdx);
          if (trOff) {
            const rpTimeOff = redPokeShiftTimeLabel(trOff.start, trOff.end);
            return {
              kind: 'dayoff',
              timeLabel: rpTimeOff,
              roleLabel: rd.groupLabel,
              dayStr,
            };
          }
          return { kind: 'empty' };
        }
        const workers = shift.workers || [shift.worker].filter(Boolean);
        const rpTime = shift.timeLabel || redPokeShiftTimeLabel(shift.start, shift.end);
        const rpBreak =
          shift.redPokeBreak || redPokeBreakAnnotation(shift.start, shift.end, rd.role, dayStr);
        const rpHrs =
          shift.redPokeHours != null
            ? String(shift.redPokeHours)
            : redPokeShiftHoursDecimal(shift.start, shift.end);
        return {
          kind: 'shift',
          shift,
          workers,
          timeLabel: rpTime,
          breakText: rpBreak,
          hours: rpHrs,
        };
      });
      if (cells.length !== colCount) {
        /* pad safety */
      }
      bodyRows.push({ kind: 'cells', cells });
    }
  });

  return bodyRows;
}

export function parseShiftIdParts(shiftId: string): { globalDayIdx: number; roleIdx: number; trIdx: number } | null {
  const m = String(shiftId || '').match(/^shift-(\d+)-(\d+)-(\d+)$/);
  if (!m) return null;
  return {
    globalDayIdx: parseInt(m[1], 10),
    roleIdx: parseInt(m[2], 10),
    trIdx: parseInt(m[3], 10),
  };
}

export function updateAssignmentWorkers(
  store: AssignmentStore,
  restaurantId: string,
  shiftId: string,
  workers: string[]
): AssignmentStore {
  const next = JSON.parse(JSON.stringify(store)) as AssignmentStore;
  if (!next[restaurantId]) next[restaurantId] = {};
  next[restaurantId][shiftId] = workers.filter(Boolean);
  return next;
}

/** Local calendar date `YYYY-MM-DD` (same idea as web `localTodayISO`). */
export function localTodayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Week labels for availability submissions (same logic as web `getAvailabilityWeekOptions`). */
export function getAvailabilityWeekOptions(weekMeta: WeekMeta[]): {
  weekIndex: number;
  startIso: string;
  label: string;
}[] {
  const todayIso = localTodayISO();
  const out: { weekIndex: number; startIso: string; label: string }[] = [];
  for (let wi = 0; wi < SCHEDULE_VIEW_WEEK_COUNT; wi += 1) {
    const startMeta = weekMeta[wi * 7];
    if (!startMeta) continue;
    if (String(startMeta.iso) < String(todayIso)) continue;
    const prefix = out.length === 0 ? 'This week' : out.length === 1 ? 'Next week' : `Week ${out.length + 1}`;
    out.push({
      weekIndex: wi,
      startIso: startMeta.iso,
      label: `${prefix} (${startMeta.label})`,
    });
  }
  if (!out.length && weekMeta[0]) {
    out.push({
      weekIndex: 0,
      startIso: weekMeta[0].iso,
      label: `This week (${weekMeta[0].label})`,
    });
  }
  return out;
}

/** Whether `workerFullName` appears in this shift’s assignee list (ported from web `shiftRowIncludesWorker`). */
export function shiftRowIncludesWorker(shiftRow: Pick<ScheduleRow, 'workers'>, workerFullName: string): boolean {
  const target = String(workerFullName || '')
    .trim()
    .toLowerCase();
  if (!target) return false;
  const workers = shiftRow.workers || [];
  return workers.some((w) => {
    const wc = String(w || '')
      .trim()
      .toLowerCase();
    if (wc === target) return true;
    const wa = wc.split(/\s+/).filter(Boolean);
    const ta = target.split(/\s+/).filter(Boolean);
    if (!wa.length || !ta.length) return false;
    if (wa[0] !== ta[0]) return false;
    if (wa.length === 1 || ta.length === 1) return wa[0] === ta[0];
    const wl = wa[wa.length - 1].replace(/\.$/, '');
    const tl = ta[ta.length - 1].replace(/\.$/, '');
    if (wl === tl) return true;
    if (wl.length && tl.length && wl[0] === tl[0]) return true;
    return false;
  });
}

/** One scheduled shift for an employee, including location and calendar metadata. */
export type WorkerShiftRow = ScheduleRow & {
  restaurantId: string;
  restaurantName: string;
  iso: string;
  dayNameUpper: string;
};

/**
 * All shifts across locations where the worker is assigned (merged `team_state.schedule_assignments`).
 * Uses the same `buildSchedule` pipeline as the manager calendar.
 */
export function buildAllLocationsWorkerShiftRows(
  weekMeta: WeekMeta[],
  params: {
    allWeekDays: string[];
    draftRows: DraftGrid;
    employees: EmployeeLite[];
    restaurants: Restaurant[];
    assignmentStore: AssignmentStore;
    workerName: string;
  }
): WorkerShiftRow[] {
  const { allWeekDays, draftRows, employees, restaurants, assignmentStore, workerName } = params;
  const labelToMeta = new Map(weekMeta.map((m) => [m.label, m]));
  const out: WorkerShiftRow[] = [];
  for (const rest of restaurants) {
    const schedule = buildSchedule({
      allWeekDays,
      draftRows,
      employees,
      restaurants,
      currentRestaurantId: rest.id,
      assignmentStore,
    });
    for (const s of schedule) {
      if (!shiftRowIncludesWorker(s, workerName)) continue;
      const meta = labelToMeta.get(s.day);
      out.push({
        ...s,
        restaurantId: rest.id,
        restaurantName: rest.name,
        iso: meta?.iso ?? '',
        dayNameUpper: meta?.dayNameUpper ?? '',
      });
    }
  }
  return out;
}

/** Today vs future shifts for the employee portal (mirrors web `getWorkerScheduleBuckets`). */
export function getWorkerScheduleBuckets(params: {
  workerName: string;
  weekMeta: WeekMeta[];
  allWeekDays: string[];
  draftRows: DraftGrid;
  employees: EmployeeLite[];
  restaurants: Restaurant[];
  assignmentStore: AssignmentStore;
}): { today: WorkerShiftRow[]; upcoming: WorkerShiftRow[] } {
  const { workerName, weekMeta, allWeekDays, draftRows, employees, restaurants, assignmentStore } = params;
  const all = buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftRows,
    employees,
    restaurants,
    assignmentStore,
    workerName,
  });
  const todayIso = localTodayISO();
  const today: WorkerShiftRow[] = [];
  const upcoming: WorkerShiftRow[] = [];
  for (const o of all) {
    if (o.iso === todayIso) today.push(o);
    else if (o.iso && o.iso > todayIso) upcoming.push(o);
  }
  upcoming.sort((a, b) => {
    if (a.iso !== b.iso) return a.iso.localeCompare(b.iso);
    return a.start.localeCompare(b.start);
  });
  today.sort((a, b) => a.start.localeCompare(b.start));
  return { today, upcoming };
}
