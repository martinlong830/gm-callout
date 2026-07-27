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

/** Fixed restaurant order when merging `all` location filter (9th Ave then 8th Ave). */
export const LOCATION_SORT_ORDER = ['rp-9', 'rp-8'] as const;

export type SenioritySortable = {
  firstName?: string;
  lastName?: string;
  displayName?: string;
  staffType?: string;
  meta?: Record<string, unknown> | null;
  usualRestaurant?: string;
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

function displayNameSortKey(emp: SenioritySortable | null | undefined): string {
  if (!emp) return '';
  const dn = String(
    (emp.displayName || [emp.firstName, emp.lastName].filter(Boolean).join(' ')) || ''
  ).trim();
  return dn;
}

/** Alphabetical by display name (Team page + leftover schedule/timecard rows). */
export function compareEmployeesByDisplayName(
  a: SenioritySortable | null | undefined,
  b: SenioritySortable | null | undefined
): number {
  return displayNameSortKey(a).localeCompare(displayNameSortKey(b), undefined, {
    sensitivity: 'base',
  });
}

/**
 * Home / primary store used when sorting under the `all` location filter.
 * Single-store staff → that store; multi-store → primaryLocationId (default rp-9).
 */
export function employeeSortStoreId(emp: SenioritySortable | null | undefined): string {
  const u = String((emp && emp.usualRestaurant) || 'rp-9');
  if (u === 'rp-8' || u === 'rp-9') return u;
  if (u === 'both') {
    const meta = emp && emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
    const raw = meta.primaryLocationId ?? meta.primaryRestaurantId;
    const id = raw != null ? String(raw).trim() : '';
    if (id === 'rp-8' || id === 'rp-9') return id;
    return 'rp-9';
  }
  return 'rp-9';
}

export function locationSortRank(storeId: string): number {
  const idx = (LOCATION_SORT_ORDER as readonly string[]).indexOf(storeId);
  return idx >= 0 ? idx : 99;
}

/** Lower index = higher on schedule sheet (Mark first). Kept for legacy sheet matching. */
export function scheduleIndexForEmployee(emp: EmployeeRow): number {
  for (let i = 0; i < SHEET_ROSTER_ORDER.length; i += 1) {
    if (employeeMatchesSheetName(emp, SHEET_ROSTER_ORDER[i])) return i;
  }
  const dept = ROSTER_DEPT_RANK[emp.staffType] ?? 99;
  return 1000 + dept * 100;
}

/** Role section order (FOH → BOH → Delivery), then alphabetical within section. */
export function compareEmployeesByScheduleOrder(a: EmployeeRow, b: EmployeeRow): number {
  const ra = ROSTER_DEPT_RANK[a.staffType] ?? 99;
  const rb = ROSTER_DEPT_RANK[b.staffType] ?? 99;
  if (ra !== rb) return ra - rb;
  return compareEmployeesByDisplayName(a, b);
}

/**
 * Compare by main-schedule visual order when ranks are known; otherwise alphabetical.
 * People not on a schedule slot sort after scheduled people (alpha among leftovers).
 * `rankByNameKey` maps normalized display names → visual rank.
 */
export function compareEmployeesByVisualScheduleOrder(
  a: EmployeeRow,
  b: EmployeeRow,
  rankByNameKey: Map<string, number> | null | undefined
): number {
  if (rankByNameKey && rankByNameKey.size) {
    const ka = normNameKey(employeeDisplayName(a));
    const kb = normNameKey(employeeDisplayName(b));
    const ra = ka ? rankByNameKey.get(ka) : undefined;
    const rb = kb ? rankByNameKey.get(kb) : undefined;
    const aOn = ra != null;
    const bOn = rb != null;
    if (aOn && bOn && ra !== rb) return ra - rb;
    if (aOn !== bOn) return aOn ? -1 : 1;
  }
  return compareEmployeesByDisplayName(a, b);
}

/**
 * Timecards / full-report sort for a location filter.
 * Single restaurant → that store's slot order (then alpha leftovers).
 * `all` → primary store order, then that store's slot order, then alpha leftovers.
 */
export function compareEmployeesByLocationScheduleOrder(
  a: EmployeeRow,
  b: EmployeeRow,
  locationFilter: string,
  rankMapForStore: (storeId: string) => Map<string, number> | null | undefined
): number {
  if (locationFilter && locationFilter !== 'all') {
    return compareEmployeesByVisualScheduleOrder(a, b, rankMapForStore(locationFilter));
  }
  const sa = employeeSortStoreId(a);
  const sb = employeeSortStoreId(b);
  const storeCmp = locationSortRank(sa) - locationSortRank(sb);
  if (storeCmp !== 0) return storeCmp;
  return compareEmployeesByVisualScheduleOrder(a, b, rankMapForStore(sa));
}
