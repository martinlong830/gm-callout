import { employeeDisplayName, type EmployeeRow } from '../employees';

/** Matches app.js schedule sheet row order (FOH → BOH → Delivery). */
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

const SHEET_ROSTER_ORDER = [
  ...TEAM_ROSTER_BARTENDER,
  ...TEAM_ROSTER_KITCHEN,
  ...TEAM_ROSTER_SERVER,
];

const ROSTER_DEPT_RANK: Record<string, number> = { Bartender: 0, Kitchen: 1, Server: 2 };

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
