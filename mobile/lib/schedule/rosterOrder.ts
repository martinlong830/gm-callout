import { employeeDisplayName, type EmployeeRow } from '../employees';

/** Matches web `SCHEDULE_GRID_ROLE_ORDER` / calendar section order (FOH → BOH → Delivery). */
export const SCHEDULE_GRID_ROLE_ORDER = ['Bartender', 'Kitchen', 'Server'] as const;

/** Front of House (Bartender) — matches FOH schedule sheet / web `TEAM_ROSTER_BARTENDER`. */
export const TEAM_ROSTER_BARTENDER = [
  'MARK ONG',
  'CHARLES JAKOB ZACANI',
  'MAEVE WILLIAMS',
  'JON ARELLANO',
  'EUGENE VILLARRUZ',
] as const;

export const TEAM_ROSTER_KITCHEN = [
  'BALTAZAR LUCAS',
  'ENRIQUE CUMES',
  'ARMANDO CUMES',
  'BERNABE DE LEON',
  'ZEFERINO FLORES',
  'IRINEO PINEDA',
] as const;

export const TEAM_ROSTER_SERVER = ['JUAN SALVATIERRA', 'NATALIO DE LA CRUZ', 'ABEL LUJAN'] as const;

const ROSTER_BY_ROLE: Record<(typeof SCHEDULE_GRID_ROLE_ORDER)[number], readonly string[]> = {
  Bartender: TEAM_ROSTER_BARTENDER,
  Kitchen: TEAM_ROSTER_KITCHEN,
  Server: TEAM_ROSTER_SERVER,
};

const SHEET_ROSTER_ORDER = SCHEDULE_GRID_ROLE_ORDER.flatMap((role) => [...ROSTER_BY_ROLE[role]]);

const ROSTER_DEPT_RANK: Record<string, number> = {
  Bartender: SCHEDULE_GRID_ROLE_ORDER.indexOf('Bartender'),
  Kitchen: SCHEDULE_GRID_ROLE_ORDER.indexOf('Kitchen'),
  Server: SCHEDULE_GRID_ROLE_ORDER.indexOf('Server'),
};

export type SenioritySortable = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  staffType?: string;
  meta?: Record<string, unknown> | null;
};

function normNameKey(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function nameLastToken(s: string): string {
  const parts = normNameKey(s).split(' ').filter(Boolean);
  return parts.length ? parts[parts.length - 1].replace(/\.$/, '') : '';
}

function nameFirstToken(s: string): string {
  const parts = normNameKey(s).split(' ').filter(Boolean);
  return parts.length ? parts[0] : '';
}

export function employeeMatchesSheetName(emp: EmployeeRow, sheetName: string): boolean {
  const a = normNameKey(employeeDisplayName(emp));
  const b = normNameKey(sheetName);
  if (!a || !b) return false;
  if (a === b) return true;
  return nameFirstToken(a) === nameFirstToken(b) && nameLastToken(a) === nameLastToken(b);
}

/** Parse `meta.hiringDate` (e.g. 3/25/2023 or ISO). Invalid / missing → null. */
export function parseEmployeeHiringDateMs(emp: SenioritySortable | null | undefined): number | null {
  const raw =
    emp && emp.meta && emp.meta.hiringDate != null ? String(emp.meta.hiringDate).trim() : '';
  if (!raw) return null;
  const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const month = Number(mdy[1]) - 1;
    const day = Number(mdy[2]);
    const year = Number(mdy[3]);
    const d = new Date(year, month, day);
    if (d.getFullYear() === year && d.getMonth() === month && d.getDate() === day) {
      return d.getTime();
    }
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
    const iso = new Date(raw.slice(0, 10) + 'T12:00:00');
    if (!Number.isNaN(iso.getTime())) return iso.getTime();
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : parsed;
}

function employeeFirstNameSortKey(emp: SenioritySortable | null | undefined): string {
  const f = String((emp && emp.firstName) || '').trim();
  if (f) return f;
  const dn = String(
    (emp && (emp.displayName || [emp.firstName, emp.lastName].filter(Boolean).join(' '))) || ''
  ).trim();
  const parts = dn.split(/\s+/).filter(Boolean);
  return parts[0] || dn;
}

/**
 * Within a role group: hire date ascending (most senior first);
 * missing hire date → after dated; ties / no-date → alphabetical by first name.
 */
export function compareEmployeesBySeniority(
  a: SenioritySortable | null | undefined,
  b: SenioritySortable | null | undefined
): number {
  const ta = parseEmployeeHiringDateMs(a);
  const tb = parseEmployeeHiringDateMs(b);
  const aHas = ta != null;
  const bHas = tb != null;
  if (aHas && bHas && ta !== tb) return ta - tb;
  if (aHas !== bHas) return aHas ? -1 : 1;
  return employeeFirstNameSortKey(a).localeCompare(employeeFirstNameSortKey(b), undefined, {
    sensitivity: 'base',
  });
}

/** Lower index = higher on schedule sheet (Mark first). Kept for legacy sheet matching. */
export function scheduleIndexForEmployee(emp: EmployeeRow): number {
  for (let i = 0; i < SHEET_ROSTER_ORDER.length; i += 1) {
    if (employeeMatchesSheetName(emp, SHEET_ROSTER_ORDER[i])) return i;
  }
  const dept = ROSTER_DEPT_RANK[emp.staffType] ?? 99;
  return 1000 + dept * 100;
}

/** Role section order (FOH → BOH → Delivery), then seniority within section. */
export function compareEmployeesByScheduleOrder(a: EmployeeRow, b: EmployeeRow): number {
  const ra = ROSTER_DEPT_RANK[a.staffType] ?? 99;
  const rb = ROSTER_DEPT_RANK[b.staffType] ?? 99;
  if (ra !== rb) return ra - rb;
  return compareEmployeesBySeniority(a, b);
}
