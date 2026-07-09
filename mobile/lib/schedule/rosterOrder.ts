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

/** Lower index = higher on schedule sheet (Mark first). */
export function scheduleIndexForEmployee(emp: EmployeeRow): number {
  for (let i = 0; i < SHEET_ROSTER_ORDER.length; i += 1) {
    if (employeeMatchesSheetName(emp, SHEET_ROSTER_ORDER[i])) return i;
  }
  const dept = ROSTER_DEPT_RANK[emp.staffType] ?? 99;
  return 1000 + dept * 100;
}

export function compareEmployeesByScheduleOrder(a: EmployeeRow, b: EmployeeRow): number {
  const ia = scheduleIndexForEmployee(a);
  const ib = scheduleIndexForEmployee(b);
  if (ia !== ib) return ia - ib;
  return employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, { sensitivity: 'base' });
}
