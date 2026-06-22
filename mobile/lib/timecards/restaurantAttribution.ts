import type { EmployeeRow } from '../employees';
import { employeeDisplayName } from '../employees';
import type { AssignmentStore, DraftGrid, Restaurant, WeekMeta } from '../schedule/types';
import { buildAllLocationsWorkerShiftRows, shiftRowIncludesWorker, type WorkerShiftRow } from '../schedule/engine';
import { isoFromDate } from './payWeek';
import type { TimeClockEntry } from './types';

export type LocationFilter = 'all' | 'rp-9' | 'rp-8';

export type RestaurantAttributionContext = {
  weekMeta: WeekMeta[];
  allWeekDays: string[];
  draftScheduleRaw?: unknown;
  draftRows?: DraftGrid;
  restaurants: Restaurant[];
  assignmentStore: AssignmentStore;
};

const VALID_RESTAURANTS = new Set(['rp-9', 'rp-8']);

function punchDayIso(entry: TimeClockEntry): string {
  return isoFromDate(new Date(entry.clock_in_at));
}

function shiftRestaurantId(shift: WorkerShiftRow | null | undefined): string {
  return shift?.restaurantId && VALID_RESTAURANTS.has(shift.restaurantId) ? shift.restaurantId : 'rp-9';
}

function isDefaultUnassignedScheduleRestaurant(restaurantId: string, restaurants: RestaurantAttributionContext['restaurants']): boolean {
  const r = restaurants.find((x) => x.id === restaurantId);
  return !!r?.defaultUnassignedSchedule || restaurantId === 'rp-8';
}

export function employeeHomeRestaurant(emp: EmployeeRow): string {
  const u = emp.usualRestaurant;
  return u === 'rp-8' || u === 'rp-9' || u === 'both' ? u : 'rp-9';
}

/** Home store determines roster membership; use All locations for cross-store payroll. */
export function rosterRowVisibleAtLocation(emp: EmployeeRow, locationFilter: LocationFilter): boolean {
  if (locationFilter === 'all') return true;
  const home = employeeHomeRestaurant(emp);
  return home === 'both' || home === locationFilter;
}

export function dishwasherTipMatchesLocationFilter(
  parsed: { restaurantId: string } | null,
  locationFilter: LocationFilter
): boolean {
  if (!parsed) return false;
  if (locationFilter === 'all') return true;
  return parsed.restaurantId === locationFilter;
}

function preferRestaurantAmongMatches(emp: EmployeeRow, matches: WorkerShiftRow[]): string | null {
  if (!matches.length) return null;
  if (matches.length === 1) return shiftRestaurantId(matches[0]);
  const home = employeeHomeRestaurant(emp);
  if (home !== 'both') {
    for (const m of matches) {
      if (shiftRestaurantId(m) === home) return home;
    }
  }
  for (const m of matches) {
    if (shiftRestaurantId(m) === 'rp-9') return 'rp-9';
  }
  return shiftRestaurantId(matches[0]);
}

function scheduleRowsForEmployee(scheduleCtx: RestaurantAttributionContext, emp: EmployeeRow): WorkerShiftRow[] {
  const name = employeeDisplayName(emp);
  const { weekMeta, allWeekDays, draftScheduleRaw, draftRows, restaurants, assignmentStore } = scheduleCtx;
  return buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftScheduleRaw,
    draftRows,
    employees: [],
    restaurants,
    assignmentStore,
    workerName: name,
  });
}

export function findScheduleShiftsForEntry(
  emp: EmployeeRow,
  entry: TimeClockEntry,
  scheduleCtx: RestaurantAttributionContext
): WorkerShiftRow[] {
  const sid = entry?.schedule_shift_id;
  if (!sid) return [];
  const name = employeeDisplayName(emp);
  const matches = scheduleRowsForEmployee(scheduleCtx, emp).filter(
    (s) => s.id === sid && shiftRowIncludesWorker(s, name)
  );
  const kioskRest = entry.clock_restaurant_id;
  if (kioskRest === 'rp-8' || kioskRest === 'rp-9') {
    const scoped = matches.filter((s) => shiftRestaurantId(s) === kioskRest);
    if (scoped.length) return scoped;
  }
  return matches;
}

export function punchDayRestaurantId(
  emp: EmployeeRow,
  iso: string,
  entries: TimeClockEntry[],
  scheduleCtx: RestaurantAttributionContext
): string {
  if (!iso) return 'rp-9';
  const dayEntries = entries.filter((e) => e.employee_id === emp.id && punchDayIso(e) === iso);
  for (const e of dayEntries) {
    if (e.clock_restaurant_id === 'rp-8' || e.clock_restaurant_id === 'rp-9') {
      return e.clock_restaurant_id;
    }
  }
  const name = employeeDisplayName(emp);
  const labelToMeta = new Map(scheduleCtx.weekMeta.map((m) => [m.label, m]));
  const restaurants = new Set<string>();
  for (const s of scheduleRowsForEmployee(scheduleCtx, emp)) {
    const meta = labelToMeta.get(s.day);
    if (!meta || meta.iso !== iso) continue;
    if (!shiftRowIncludesWorker(s, name)) continue;
    restaurants.add(shiftRestaurantId(s));
  }
  const rests = [...restaurants];
  if (rests.length === 1) {
    const only = rests[0];
    const home = employeeHomeRestaurant(emp);
    if (home !== 'both' && only !== home && isDefaultUnassignedScheduleRestaurant(only, scheduleCtx.restaurants)) {
      return home;
    }
    return only;
  }
  if (rests.length > 1) {
    for (const e of dayEntries) {
      const matches = findScheduleShiftsForEntry(emp, e, scheduleCtx);
      if (matches.length) {
        const pick = preferRestaurantAmongMatches(emp, matches);
        if (pick) return pick;
      }
    }
    const dayShifts = scheduleRowsForEmployee(scheduleCtx, emp).filter((s) => {
      const meta = labelToMeta.get(s.day);
      return meta?.iso === iso && shiftRowIncludesWorker(s, name);
    });
    const pick = preferRestaurantAmongMatches(emp, dayShifts);
    if (pick) return pick;
  }
  return 'rp-9';
}

/** Which store a punch row belongs to (kiosk attribution, schedule link, or day inference). */
export function entryRestaurantId(
  emp: EmployeeRow,
  entry: TimeClockEntry,
  entries: TimeClockEntry[],
  scheduleCtx: RestaurantAttributionContext
): string {
  if (!entry) return 'rp-9';
  if (entry.clock_restaurant_id === 'rp-8' || entry.clock_restaurant_id === 'rp-9') {
    return entry.clock_restaurant_id;
  }
  const matches = findScheduleShiftsForEntry(emp, entry, scheduleCtx);
  if (matches.length) {
    const pick = preferRestaurantAmongMatches(emp, matches);
    if (pick) return pick;
  }
  return punchDayRestaurantId(emp, punchDayIso(entry), entries, scheduleCtx);
}
