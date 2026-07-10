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
  ScheduleAssignmentEntry,
  ScheduleRow,
  WeekMeta,
  WeekdayKey,
} from './types';

/** Matches web portal `SCHEDULE_PAST_WEEK_COUNT` / anchor week grid. */
export const SCHEDULE_PAST_WEEK_COUNT = 12;
/** Weeks after the current block (not counting the current week). */
export const SCHEDULE_FUTURE_WEEK_COUNT = 2;
export const SCHEDULE_VIEW_WEEK_COUNT =
  SCHEDULE_PAST_WEEK_COUNT + 1 + SCHEDULE_FUTURE_WEEK_COUNT;
/** Index in `WEEK_META` for this calendar week; also the replication template week. */
export const SCHEDULE_TEMPLATE_WEEK_INDEX = SCHEDULE_PAST_WEEK_COUNT;
/** Employee portal shows current pay week + next 2 future weeks. */
export const EMPLOYEE_SCHEDULE_VISIBLE_WEEK_COUNT = 3;
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

/** Front of House (Bartender) — matches FOH schedule sheet / web `TEAM_ROSTER_BARTENDER`. */
export const TEAM_ROSTER_BARTENDER = [
  'MARK ONG',
  'CHARLES JAKOB ZACANI',
  'MAEVE WILLIAMS',
  'JON ARELLANO',
  'EUGENE VILLARRUZ',
];
export const TEAM_ROSTER_KITCHEN = [
  'BALTAZAR LUCAS',
  'ENRIQUE CUMES',
  'ARMANDO CUMES',
  'BERNABE DE LEON',
  'ZEFERINO FLORES',
  'IRINEO PINEDA',
];
export const TEAM_ROSTER_SERVER = [
  'JUAN SALVATIERRA',
  'NATALIO DE LA CRUZ',
  'ABEL LUJAN',
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
    [
      ['11:30', '22:00'],
      ['10:30', '20:30'],
      ['10:30', '20:30'],
      null,
      null,
      ['10:00', '18:00'],
      ['10:00', '18:00'],
    ],
  ],
};

export function defaultRestaurants(): Restaurant[] {
  return [
    { id: 'rp-9', shortLabel: '9th Ave', name: 'Red Poke 598 9th Ave' },
    {
      id: 'rp-8',
      shortLabel: '8th Ave',
      name: 'Red Poke 885 8th Ave',
      defaultUnassignedSchedule: true,
    },
  ];
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
  /* Office break is Mark-only — never assign via hash placeholder. */
  const opts = [
    '(3:00PM BREAK TIME)',
    '(3:30PM BREAK TIME)',
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

const DRAFT_ROLE_KEYS: RoleKey[] = ['Bartender', 'Kitchen', 'Server'];

function draftScheduleJsonHasLayers(obj: unknown): obj is DraftGrid {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;
  return DRAFT_ROLE_KEYS.some((role) => Array.isArray(p[role]) && (p[role] as unknown[]).length > 0);
}

function draftScheduleWeekEntryIsPerRestaurant(weekEntry: unknown): boolean {
  if (!weekEntry || typeof weekEntry !== 'object') return false;
  if (draftScheduleJsonHasLayers(weekEntry)) return false;
  const p = weekEntry as Record<string, unknown>;
  return defaultRestaurants().some((r) => draftScheduleJsonHasLayers(p[r.id]));
}

function resolveDraftRestaurantId(restaurantId?: string): string {
  const rests = defaultRestaurants();
  if (restaurantId && rests.some((r) => r.id === restaurantId)) return restaurantId;
  return rests[0]?.id ?? 'rp-9';
}

function draftLayersFromWeekEntry(weekEntry: unknown, restaurantId?: string): DraftGrid | null {
  if (!weekEntry || typeof weekEntry !== 'object') return null;
  if (draftScheduleWeekEntryIsPerRestaurant(weekEntry)) {
    const rid = resolveDraftRestaurantId(restaurantId);
    const perRest = (weekEntry as Record<string, unknown>)[rid];
    if (draftScheduleJsonHasLayers(perRest)) {
      return loadDraftFromTeamState(perRest);
    }
    return null;
  }
  if (draftScheduleJsonHasLayers(weekEntry)) {
    return loadDraftFromTeamState(weekEntry);
  }
  return null;
}

export function loadDraftFromTeamState(raw: unknown, weekIndex?: number, restaurantId?: string): DraftGrid {
  const base = cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
  if (!raw || typeof raw !== 'object') return base;
  const p = raw as Record<string, unknown>;
  if (p.byWeek && typeof p.byWeek === 'object') {
    const byWeek = p.byWeek as Record<string, unknown>;
    const wi =
      weekIndex != null && !Number.isNaN(weekIndex)
        ? String(weekIndex)
        : String(SCHEDULE_TEMPLATE_WEEK_INDEX);
    const weekLayers = byWeek[wi];
    const layers = draftLayersFromWeekEntry(weekLayers, restaurantId);
    if (layers) return layers;
    if (wi !== String(SCHEDULE_TEMPLATE_WEEK_INDEX)) {
      const tplLayers = byWeek[String(SCHEDULE_TEMPLATE_WEEK_INDEX)];
      const tplDraft = draftLayersFromWeekEntry(tplLayers, restaurantId);
      if (tplDraft) return tplDraft;
    }
    return base;
  }
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

/** Monday that starts the multi-week schedule grid (12 weeks before this Monday). */
export function getScheduleAnchorMondayDate(): Date {
  const mon = getThisMondayDate();
  return new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() - SCHEDULE_PAST_WEEK_COUNT * 7);
}

export function getEmployeeVisibleWeekIndices(): number[] {
  return Array.from(
    { length: EMPLOYEE_SCHEDULE_VISIBLE_WEEK_COUNT },
    (_, i) => SCHEDULE_TEMPLATE_WEEK_INDEX + i
  );
}

function draftForWeek(
  draftScheduleRaw: unknown | undefined,
  draftRows: DraftGrid | undefined,
  weekIndex: number,
  restaurantId?: string
): DraftGrid {
  if (draftScheduleRaw != null) {
    return loadDraftFromTeamState(draftScheduleRaw, weekIndex, restaurantId);
  }
  return draftRows ?? cloneDraftSchedule(DEFAULT_DRAFT_SCHEDULE_ROWS);
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

type NormalizedScheduleAssignment = {
  workers: string[];
  break?: string;
  hours?: string;
  timeLabel?: string;
  breakPaid?: boolean;
};

/** Assignment value: `['Name']` legacy, or `{ workers, break?, hours?, timeLabel? }` from FOH sheet. */
export function normalizeScheduleAssignment(val: ScheduleAssignmentEntry | null | undefined): NormalizedScheduleAssignment {
  if (val == null) return { workers: ['Unassigned'] };
  if (Array.isArray(val)) {
    const w = val.filter((n) => n && n !== 'Unassigned');
    return { workers: w.length ? w.slice() : ['Unassigned'] };
  }
  if (typeof val === 'object') {
    const workers = Array.isArray(val.workers)
      ? val.workers.filter((n) => n && n !== 'Unassigned')
      : [];
    const out: NormalizedScheduleAssignment = { workers: workers.length ? workers : ['Unassigned'] };
    if (val.break) out.break = String(val.break);
    if (val.hours != null && val.hours !== '') out.hours = String(val.hours);
    if (val.timeLabel) out.timeLabel = String(val.timeLabel);
    if (val.breakPaid === true || val.breakPaid === false) out.breakPaid = !!val.breakPaid;
    return out;
  }
  return { workers: ['Unassigned'] };
}

function cloneScheduleAssignment(val: ScheduleAssignmentEntry | null | undefined): NormalizedScheduleAssignment {
  return JSON.parse(JSON.stringify(normalizeScheduleAssignment(val)));
}

function workerNamesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const wc = String(a || '').trim().toLowerCase();
  const target = String(b || '').trim().toLowerCase();
  if (!wc || !target) return false;
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
}

function scheduleAssignmentPrimaryWorker(entry: NormalizedScheduleAssignment | null | undefined): string | null {
  const workers = (entry?.workers || []).filter((w) => w && w !== 'Unassigned');
  return workers.length ? workers[0] : null;
}

/** Template-week break metadata applies only when the staffed worker matches that slot's pattern. */
function scheduleAssignmentWorkersAlignedForBreakInherit(
  direct: NormalizedScheduleAssignment | null | undefined,
  pattern: NormalizedScheduleAssignment | null | undefined
): boolean {
  if (!pattern) return false;
  const directWorker = scheduleAssignmentPrimaryWorker(direct);
  const patternWorker = scheduleAssignmentPrimaryWorker(pattern);
  if (!directWorker || !patternWorker) return true;
  return workerNamesMatch(directWorker, patternWorker);
}

function resolveInheritedScheduleBreak(
  direct: NormalizedScheduleAssignment | null | undefined,
  pattern: NormalizedScheduleAssignment | null | undefined,
  resolvedWorkers?: string[]
): string | undefined {
  if (direct?.break) return direct.break;
  if (!pattern?.break) return undefined;
  const directLike = direct || { workers: resolvedWorkers || ['Unassigned'] };
  if (scheduleAssignmentWorkersAlignedForBreakInherit(directLike, pattern)) {
    return pattern.break;
  }
  return undefined;
}

/** Mon–Sun pattern from the template ("this") week — used for all calendar weeks. */
function lookupScheduleAssignmentPattern(
  stored: Record<string, ScheduleAssignmentEntry>,
  shiftId: string
): NormalizedScheduleAssignment | null {
  const p = parseShiftIdParts(shiftId);
  if (!p) return null;
  const tplStart = SCHEDULE_TEMPLATE_WEEK_INDEX * 7;
  const dayInWeek = p.globalDayIdx % 7;
  if (p.globalDayIdx >= tplStart && p.globalDayIdx < tplStart + 7) {
    const legacyInTpl = `shift-${dayInWeek}-${p.roleIdx}-${p.trIdx}`;
    if (stored[legacyInTpl] != null) {
      return normalizeScheduleAssignment(stored[legacyInTpl]);
    }
  }
  const templateId = `shift-${tplStart + dayInWeek}-${p.roleIdx}-${p.trIdx}`;
  if (stored[templateId] != null) {
    return normalizeScheduleAssignment(stored[templateId]);
  }
  const legacyTplId = `shift-${dayInWeek}-${p.roleIdx}-${p.trIdx}`;
  if (stored[legacyTplId] != null) {
    return normalizeScheduleAssignment(stored[legacyTplId]);
  }
  return null;
}

function mergeScheduleAssignmentEntries(
  direct: NormalizedScheduleAssignment | null,
  pattern: NormalizedScheduleAssignment | null
): NormalizedScheduleAssignment | null {
  if (!direct && !pattern) return null;
  if (!pattern) return direct;
  if (!direct) return pattern;
  const out: NormalizedScheduleAssignment = { workers: direct.workers };
  const inheritedBreak = resolveInheritedScheduleBreak(direct, pattern, out.workers);
  if (inheritedBreak) out.break = inheritedBreak;
  if (direct.hours != null && direct.hours !== '') out.hours = direct.hours;
  else if (pattern.hours != null && pattern.hours !== '') out.hours = pattern.hours;
  if (direct.timeLabel || pattern.timeLabel) out.timeLabel = direct.timeLabel || pattern.timeLabel;
  if (direct.breakPaid === true || direct.breakPaid === false) out.breakPaid = direct.breakPaid;
  else if (pattern.breakPaid === true || pattern.breakPaid === false) out.breakPaid = pattern.breakPaid;
  return out;
}

/** Per-shift assignment; inherits break/hours/time from template week when missing. */
function lookupScheduleAssignment(
  stored: Record<string, ScheduleAssignmentEntry>,
  shiftId: string
): NormalizedScheduleAssignment | null {
  const direct = stored[shiftId] != null ? normalizeScheduleAssignment(stored[shiftId]) : null;
  const pattern = lookupScheduleAssignmentPattern(stored, shiftId);
  return mergeScheduleAssignmentEntries(direct, pattern);
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

function normNameKeyLite(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function nameFirstTokenLite(s: string): string {
  const parts = normNameKeyLite(s).split(' ').filter(Boolean);
  return parts.length ? parts[0] : '';
}

function nameLastTokenLite(s: string): string {
  const parts = normNameKeyLite(s).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/\.$/, '') : '';
}

function employeeMatchesSheetNameLite(emp: EmployeeLite, sheetName: string): boolean {
  const a = normNameKeyLite(employeeDisplayNameLite(emp));
  const b = normNameKeyLite(sheetName);
  if (!a || !b) return false;
  if (a === b) return true;
  return nameFirstTokenLite(a) === nameFirstTokenLite(b) && nameLastTokenLite(a) === nameLastTokenLite(b);
}

function scheduleIndexForEmployeeLite(emp: EmployeeLite): number {
  const sheetOrder = [
    ...TEAM_ROSTER_BARTENDER,
    ...TEAM_ROSTER_KITCHEN,
    ...TEAM_ROSTER_SERVER,
  ];
  for (let i = 0; i < sheetOrder.length; i += 1) {
    if (employeeMatchesSheetNameLite(emp, sheetOrder[i])) return i;
  }
  const deptRank: Record<string, number> = { Bartender: 0, Kitchen: 1, Server: 2 };
  return 1000 + (deptRank[emp.staffType] ?? 99) * 100;
}

function compareEmployeesByScheduleOrderLite(a: EmployeeLite, b: EmployeeLite): number {
  const ia = scheduleIndexForEmployeeLite(a);
  const ib = scheduleIndexForEmployeeLite(b);
  if (ia !== ib) return ia - ib;
  return employeeDisplayNameLite(a).localeCompare(employeeDisplayNameLite(b), undefined, { sensitivity: 'base' });
}

function employeeDisplayNameLite(emp: EmployeeLite): string {
  if (emp.displayName) return emp.displayName.trim();
  const f = (emp.firstName || '').trim();
  const l = (emp.lastName || '').trim();
  return [f, l].filter(Boolean).join(' ') || 'Unnamed';
}

function employeeMatchesScheduleRestaurantLite(emp: EmployeeLite, restaurantId: string): boolean {
  const u = emp.usualRestaurant || 'both';
  if (u === 'both') return true;
  return u === restaurantId;
}

function employeeByDisplayNameLite(employees: EmployeeLite[], name: string): EmployeeLite | null {
  if (!name) return null;
  const exact = employees.find((e) => employeeDisplayNameLite(e) === name);
  if (exact) return exact;
  const fuzzy = employees.find((e) => workerNamesMatch(name, employeeDisplayNameLite(e)));
  if (fuzzy) return fuzzy;
  return (
    employees.find((e) => {
      const aliases = e.meta?.scheduleAliases;
      if (!Array.isArray(aliases)) return false;
      return aliases.some((alias) => alias && workerNamesMatch(name, alias));
    }) || null
  );
}

function employeeAtScheduleSlot(
  employees: EmployeeLite[],
  role: RoleKey,
  trIdx: number,
  restaurantId: string
): EmployeeLite | null {
  if (!employees.length) return null;
  return (
    employees
      .filter((e) => e.staffType === role && employeeMatchesScheduleRestaurantLite(e, restaurantId))
      .sort(compareEmployeesByScheduleOrderLite)[trIdx] || null
  );
}

function canonicalScheduleWorkerNameLite(
  employees: EmployeeLite[],
  name: string,
  restaurantId: string
): string {
  if (!name || name === 'Unassigned') return name;
  const emp = employeeByDisplayNameLite(employees, name);
  if (!emp) return name;
  if (!employeeMatchesScheduleRestaurantLite(emp, restaurantId)) return name;
  return employeeDisplayNameLite(emp);
}

function canonicalizeScheduleWorkerListLite(
  employees: EmployeeLite[],
  workers: string[],
  restaurantId: string
): string[] {
  const seen: Record<string, boolean> = Object.create(null);
  const out: string[] = [];
  (workers || []).forEach((w) => {
    if (!w || w === 'Unassigned') return;
    const canon = canonicalScheduleWorkerNameLite(employees, w, restaurantId);
    if (!canon || canon === 'Unassigned') return;
    const key = canon.trim().toLowerCase();
    if (seen[key]) return;
    seen[key] = true;
    out.push(canon);
  });
  return out.length ? out : ['Unassigned'];
}

function scheduleWorkerIsOnTeamLite(employees: EmployeeLite[], name: string, restaurantId: string): boolean {
  if (!name || name === 'Unassigned') return false;
  if (!employees.length) return true;
  return employees.some((emp) => {
    if (!employeeMatchesScheduleRestaurantLite(emp, restaurantId)) return false;
    if (workerNamesMatch(name, employeeDisplayNameLite(emp))) return true;
    const aliases = emp.meta?.scheduleAliases;
    if (!Array.isArray(aliases)) return false;
    return aliases.some((alias) => alias && workerNamesMatch(name, alias));
  });
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
  if (restaurantId === 'rp-8') return true;
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

/** FOH/BOH/Delivery rows map trIdx → Team page name at that slot (sheet row order). */
function scheduleRowRosterDefault(
  employees: EmployeeLite[],
  role: RoleKey,
  trIdx: number,
  restaurantId: string
): string | null {
  const emp = employeeAtScheduleSlot(employees, role, trIdx, restaurantId);
  if (emp) return employeeDisplayNameLite(emp);
  if (role === 'Bartender') return TEAM_ROSTER_BARTENDER[trIdx] || null;
  if (role === 'Kitchen') return TEAM_ROSTER_KITCHEN[trIdx] || null;
  if (role === 'Server') return TEAM_ROSTER_SERVER[trIdx] || null;
  return null;
}

function workerAllowedOnScheduleRow(name: string, basePool: string[]): boolean {
  if (!name || name === 'Unassigned') return false;
  if (!basePool || !basePool.length) return true;
  const key = normalizeWorkerKey(name);
  return basePool.some((n) => normalizeWorkerKey(n) === key);
}

function pickDefaultScheduleWorkers(
  employees: EmployeeLite[],
  role: RoleKey,
  trIdx: number,
  basePool: string[],
  usedToday: Record<string, boolean>,
  seed: number,
  restaurantId: string
): string[] {
  const rowName = scheduleRowRosterDefault(employees, role, trIdx, restaurantId);
  if (rowName && workerAllowedOnScheduleRow(rowName, basePool) && !usedToday[normalizeWorkerKey(rowName)]) {
    return [rowName];
  }
  const filtered = (basePool || []).filter((name) => {
    if (!name || name === 'Unassigned') return false;
    return !usedToday[normalizeWorkerKey(name)];
  });
  if (filtered.length) return uniqueWorkers(filtered, seed, 1);
  return ['Unassigned'];
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
  const p = parsed as AssignmentStore;
  restaurantIds.forEach((rid) => {
    if (p[rid] && typeof p[rid] === 'object') next[rid] = p[rid];
  });
  mergeFormerRp8AssignmentsIntoRp9(next);
  const mig = migrateScheduleAssignmentsForPastWeeks(next);
  const store = mig.store;
  const restaurants = defaultRestaurants();
  restaurantIds.forEach((rid) => {
    if (restaurantUsesDefaultUnassignedSchedule(restaurants, rid)) return;
    if (!store[rid]) store[rid] = {};
    replicateWeekZeroToFutureWeeksInStore(store[rid], SCHEDULE_VIEW_WEEK_COUNT);
  });
  purgeDefaultUnassignedRestaurantAssignments(store, restaurants);
  return store;
}

/** Fold legacy 8th Ave assignment keys into rp-9 when moving to single-site. */
function mergeFormerRp8AssignmentsIntoRp9(parsed: AssignmentStore): boolean {
  if (!parsed || typeof parsed !== 'object' || !parsed['rp-8'] || typeof parsed['rp-8'] !== 'object') {
    return false;
  }
  const n9 =
    parsed['rp-9'] && typeof parsed['rp-9'] === 'object' ? { ...parsed['rp-9'] } : {};
  const e8 = parsed['rp-8'];
  Object.keys(e8).forEach((shiftId) => {
    if (n9[shiftId] === undefined || n9[shiftId] === null) n9[shiftId] = e8[shiftId];
  });
  parsed['rp-9'] = n9;
  delete parsed['rp-8'];
  return true;
}

function migrateScheduleAssignmentsForPastWeeks(store: AssignmentStore): { store: AssignmentStore; changed: boolean } {
  if (!store || typeof store !== 'object') return { store, changed: false };
  const offset = SCHEDULE_PAST_WEEK_COUNT * 7;
  let changed = false;
  Object.keys(store).forEach((rid) => {
    const rs = store[rid];
    if (!rs || typeof rs !== 'object') return;
    const removeIds: string[] = [];
    Object.keys(rs).forEach((shiftId) => {
      const p = parseShiftIdParts(shiftId);
      if (!p || p.globalDayIdx >= offset) return;
      const newId = `shift-${p.globalDayIdx + offset}-${p.roleIdx}-${p.trIdx}`;
      if (rs[newId] == null) {
        rs[newId] = rs[shiftId];
        changed = true;
      }
      removeIds.push(shiftId);
    });
    removeIds.forEach((shiftId) => {
      delete rs[shiftId];
      changed = true;
    });
  });
  return { store, changed };
}

function replicateWeekZeroToFutureWeeksInStore(
  restAssignments: Record<string, ScheduleAssignmentEntry>,
  weekCount: number
): boolean {
  if (!restAssignments || typeof restAssignments !== 'object') return false;
  const tpl = SCHEDULE_TEMPLATE_WEEK_INDEX;
  const tplStart = tpl * 7;
  let changed = false;
  Object.keys(restAssignments).forEach((shiftId) => {
    const p = parseShiftIdParts(shiftId);
    if (!p) return;
    if (p.globalDayIdx >= tplStart + 7 && p.globalDayIdx < weekCount * 7) {
      delete restAssignments[shiftId];
      changed = true;
    }
  });
  for (let w = tpl + 1; w < weekCount; w += 1) {
    const weekStart = w * 7;
    for (let dayInWeek = 0; dayInWeek < 7; dayInWeek += 1) {
      for (let roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
        const slotCount = slotCountForRole(DEFAULT_DRAFT_SCHEDULE_ROWS, ROLE_DEFS[roleIdx].role);
        for (let trIdx = 0; trIdx < slotCount; trIdx += 1) {
          const templateId = `shift-${tplStart + dayInWeek}-${roleIdx}-${trIdx}`;
          const targetId = `shift-${weekStart + dayInWeek}-${roleIdx}-${trIdx}`;
          if (restAssignments[templateId] == null) continue;
          restAssignments[targetId] = cloneScheduleAssignment(restAssignments[templateId]);
          changed = true;
        }
      }
    }
  }
  return changed;
}

function getCurrentRestaurantAssignments(
  store: AssignmentStore,
  restaurantId: string
): Record<string, ScheduleAssignmentEntry> {
  return store[restaurantId] || {};
}

function applyScheduleAssignmentsMerge(
  schedule: ScheduleRow[],
  stored: Record<string, ScheduleAssignmentEntry>,
  employees: EmployeeLite[],
  restaurantId: string,
  skipWorkers?: boolean
) {
  schedule.forEach((s) => {
    const entry = lookupScheduleAssignment(stored, s.id);
    const slotLabel = redPokeShiftTimeLabel(s.start, s.end);
    const slotHours = redPokeShiftHoursDecimal(s.start, s.end);
    s.timeLabel = slotLabel;
    if (!entry) {
      s.redPokeHours = slotHours;
      return;
    }
    if (entry.break) {
      s.redPokeBreak = entry.break;
    } else {
      s.redPokeBreak = redPokeBreakAnnotation(s.start, s.end, s.role, s.day);
    }
    if (entry.breakPaid === true || entry.breakPaid === false) {
      s.breakPaid = !!entry.breakPaid;
    } else {
      delete s.breakPaid;
    }
    if (entry.hours != null && String(entry.hours).trim() !== '') {
      const entryH = parseFloat(entry.hours);
      const slotH = parseFloat(slotHours);
      if (!Number.isNaN(entryH) && !Number.isNaN(slotH) && Math.abs(entryH - slotH) > 0.02) {
        s.redPokeHours = slotHours;
      } else {
        s.redPokeHours = entry.hours;
      }
    } else {
      s.redPokeHours = slotHours;
    }
    if (entry.timeLabel) s.timeLabel = entry.timeLabel;
    if (skipWorkers) {
      s.workers = ['Unassigned'];
      s.worker = 'Unassigned';
      return;
    }
    const list = entry.workers.filter(
      (n) => n && n !== 'Unassigned' && scheduleWorkerIsOnTeamLite(employees, n, restaurantId)
    );
    if (!list.length) return;
    const canon = canonicalizeScheduleWorkerListLite(employees, list, restaurantId);
    s.workers = canon.slice();
    s.worker = s.workers[0];
  });
}

export function buildSchedule(params: {
  allWeekDays: string[];
  draftScheduleRaw?: unknown;
  draftRows?: DraftGrid;
  employees: EmployeeLite[];
  restaurants: Restaurant[];
  currentRestaurantId: string;
  assignmentStore: AssignmentStore;
}): ScheduleRow[] {
  const { allWeekDays, draftScheduleRaw, draftRows, employees, restaurants, currentRestaurantId, assignmentStore } =
    params;
  const pools = refreshPools(employees);
  const forceUnassigned = restaurantUsesDefaultUnassignedSchedule(restaurants, currentRestaurantId);
  const schedule: ScheduleRow[] = [];
  const stored = getCurrentRestaurantAssignments(assignmentStore, currentRestaurantId);

  allWeekDays.forEach((dayStr, globalDayIdx) => {
    const wk = weekdayKeyFromScheduleDay(dayStr);
    const weekIdx = Math.floor(globalDayIdx / 7);
    const weekDraft = draftForWeek(draftScheduleRaw, draftRows, weekIdx, currentRestaurantId);
    const usedToday: Record<string, boolean> = Object.create(null);
    ROLE_DEFS.forEach((rd, roleIdx) => {
      const n = slotCountForRole(weekDraft, rd.role);
      for (let trIdx = 0; trIdx < n; trIdx += 1) {
        const tr = draftTimeSlotFor(weekDraft, rd.role, wk, trIdx);
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
          workers = pickDefaultScheduleWorkers(
            employees,
            rd.role,
            trIdx,
            basePool,
            usedToday,
            seed,
            currentRestaurantId
          );
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

  applyScheduleAssignmentsMerge(schedule, stored, employees, currentRestaurantId, forceUnassigned);
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
  for (let wi = SCHEDULE_TEMPLATE_WEEK_INDEX; wi < SCHEDULE_VIEW_WEEK_COUNT; wi += 1) {
    const startMeta = weekMeta[wi * 7];
    if (!startMeta) continue;
    if (String(startMeta.iso) < String(todayIso)) continue;
    const prefix =
      wi === SCHEDULE_TEMPLATE_WEEK_INDEX
        ? 'This week'
        : wi === SCHEDULE_TEMPLATE_WEEK_INDEX + 1
          ? 'Next week'
          : `Week ${wi - SCHEDULE_TEMPLATE_WEEK_INDEX + 1}`;
    out.push({
      weekIndex: wi,
      startIso: startMeta.iso,
      label: `${prefix} (${startMeta.label})`,
    });
  }
  const fallbackMeta = weekMeta[SCHEDULE_TEMPLATE_WEEK_INDEX * 7];
  if (!out.length && fallbackMeta) {
    out.push({
      weekIndex: SCHEDULE_TEMPLATE_WEEK_INDEX,
      startIso: fallbackMeta.iso,
      label: `This week (${fallbackMeta.label})`,
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
    draftScheduleRaw?: unknown;
    draftRows?: DraftGrid;
    employees: EmployeeLite[];
    restaurants: Restaurant[];
    assignmentStore: AssignmentStore;
    workerName: string;
  }
): WorkerShiftRow[] {
  const { allWeekDays, draftScheduleRaw, draftRows, employees, restaurants, assignmentStore, workerName } = params;
  const labelToMeta = new Map(weekMeta.map((m) => [m.label, m]));
  const out: WorkerShiftRow[] = [];
  for (const rest of restaurants) {
    const schedule = buildSchedule({
      allWeekDays,
      draftScheduleRaw,
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
  draftScheduleRaw?: unknown;
  draftRows?: DraftGrid;
  employees: EmployeeLite[];
  restaurants: Restaurant[];
  assignmentStore: AssignmentStore;
}): { today: WorkerShiftRow[]; upcoming: WorkerShiftRow[] } {
  const {
    workerName,
    weekMeta,
    allWeekDays,
    draftScheduleRaw,
    draftRows,
    employees,
    restaurants,
    assignmentStore,
  } = params;
  const windowStartMeta = weekMeta[SCHEDULE_TEMPLATE_WEEK_INDEX * 7];
  const windowEndMeta =
    weekMeta[(SCHEDULE_TEMPLATE_WEEK_INDEX + EMPLOYEE_SCHEDULE_VISIBLE_WEEK_COUNT) * 7 - 1];
  const windowStartIso = windowStartMeta?.iso ?? '';
  const windowEndIso = windowEndMeta?.iso ?? '';
  const all = buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftScheduleRaw,
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
    if (windowStartIso && o.iso && o.iso < windowStartIso) continue;
    if (windowEndIso && o.iso && o.iso > windowEndIso) continue;
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

/** Drop saved worker rows for locations that must stay unassigned (e.g. rp-8). */
export function purgeDefaultUnassignedRestaurantAssignments(
  store: AssignmentStore,
  restaurants: Restaurant[]
): boolean {
  if (!store || typeof store !== 'object') return false;
  let changed = false;
  for (const r of restaurants) {
    if (!restaurantUsesDefaultUnassignedSchedule(restaurants, r.id)) continue;
    if (store[r.id] && Object.keys(store[r.id]).length) {
      store[r.id] = {};
      changed = true;
    } else if (!store[r.id]) {
      store[r.id] = {};
    }
  }
  return changed;
}
