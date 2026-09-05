import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import {
  appendLeaveBalanceEntries,
  LEAVE_HOURS_PER_DAY,
  type LeaveEntry,
} from './employeeLeave';
import { saveEmployeeRow } from './employeeSave';
import { employeeDisplayName, type EmployeeRow } from './employees';
import {
  buildAllLocationsWorkerShiftRows,
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  SCHEDULE_VIEW_WEEK_COUNT,
  type WorkerShiftRow,
} from './schedule/engine';
import type { AssignmentStore, DraftGrid, EmployeeLite } from './schedule/types';
import { reassignShiftWorkerInStore } from './shiftSwap';
import type { OfferedShiftRef, StaffRequestUi } from './staffRequests';
import { broadcastTeamStateChanged } from './teamStateSync';
import { scheduledPaidMinutes } from './timecards/engine';
import { clearDayLeaveOverridesInRange, parseTimeoffRequest } from './timecards/weekExtras';

const LEAVE_DEFAULT_DAY_HOURS = LEAVE_HOURS_PER_DAY;

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: (e.staffType || 'Kitchen') as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function eachIsoDayInclusive(startIso: string, endIso: string, fn: (iso: string) => void) {
  const cur = new Date(startIso + 'T12:00:00');
  const end = new Date(endIso + 'T12:00:00');
  if (Number.isNaN(cur.getTime()) || Number.isNaN(end.getTime())) return;
  while (cur <= end) {
    const y = cur.getFullYear();
    const m = String(cur.getMonth() + 1).padStart(2, '0');
    const d = String(cur.getDate()).padStart(2, '0');
    fn(`${y}-${m}-${d}`);
    cur.setDate(cur.getDate() + 1);
  }
}

export function resolveOfferedShiftRef(
  request: StaffRequestUi | null | undefined
): OfferedShiftRef | null {
  if (!request) return null;
  const s = request.offeredShift;
  if (s && s.restaurantId && s.shiftId) {
    return {
      restaurantId: String(s.restaurantId),
      shiftId: String(s.shiftId),
      day: s.day != null ? String(s.day) : undefined,
      timeLabel: s.timeLabel != null ? String(s.timeLabel) : undefined,
      iso: s.iso != null ? String(s.iso) : undefined,
    };
  }
  return null;
}

export async function persistAssignmentStore(
  sb: SupabaseClient,
  store: AssignmentStore
): Promise<
  | { ok: true; store: AssignmentStore; updatedAt?: string }
  | { ok: false; message: string }
> {
  const teamStateId = await readStoredTeamStateId();
  const up = await sb
    .from('team_state')
    .upsert(
      {
        id: teamStateId,
        schedule_assignments: store,
      },
      { onConflict: 'id' }
    )
    .select('id, updated_at')
    .single();
  if (up.error) return { ok: false, message: up.error.message };
  try {
    await broadcastTeamStateChanged(sb, teamStateId, ['schedule_assignments']);
  } catch {
    /* non-blocking */
  }
  return {
    ok: true,
    store,
    updatedAt: up.data?.updated_at != null ? String(up.data.updated_at) : undefined,
  };
}

export function unassignShiftsInStore(
  store: AssignmentStore,
  targets: { restaurantId: string; shiftId: string }[]
): AssignmentStore {
  let next = store;
  for (const t of targets) {
    if (!t.restaurantId || !t.shiftId) continue;
    next = reassignShiftWorkerInStore(next, t.restaurantId, t.shiftId, 'Unassigned');
  }
  return next;
}

function collectWorkerShifts(params: {
  employees: EmployeeRow[];
  workerName: string;
  assignmentStore: AssignmentStore;
  draftRows: DraftGrid;
  draftScheduleRaw?: unknown;
}): WorkerShiftRow[] {
  const restaurants = defaultRestaurants();
  const weekMeta = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate());
  const allWeekDays = buildAllWeekDayLabels(weekMeta);
  return buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftScheduleRaw: params.draftScheduleRaw,
    draftRows: params.draftRows,
    employees: params.employees.map(toLite),
    restaurants,
    assignmentStore: params.assignmentStore,
    workerName: params.workerName,
  });
}

function hoursByIsoFromShifts(shifts: WorkerShiftRow[], emp: EmployeeRow | null): Record<string, number> {
  const map: Record<string, number> = {};
  for (const s of shifts) {
    if (!s.iso) continue;
    map[s.iso] = (map[s.iso] || 0) + scheduledPaidMinutes(s, emp) / 60;
  }
  return map;
}

/**
 * Clear the employee from every scheduled shift on [start, end] (inclusive).
 * Returns the next assignment store (may be unchanged).
 */
export function clearWorkerScheduleOnDateRange(params: {
  employees: EmployeeRow[];
  workerName: string;
  emp?: EmployeeRow | null;
  startIso: string;
  endIso: string;
  assignmentStore: AssignmentStore;
  draftRows: DraftGrid;
  draftScheduleRaw?: unknown;
}): { store: AssignmentStore; clearedShiftIds: string[]; hoursByIso: Record<string, number> } {
  const all = collectWorkerShifts(params);
  const inRange = all.filter(
    (s) => s.iso && s.iso >= params.startIso && s.iso <= params.endIso
  );
  const hoursByIso = hoursByIsoFromShifts(inRange, params.emp ?? null);
  const targets = inRange.map((s) => ({ restaurantId: s.restaurantId, shiftId: s.id }));
  const store = unassignShiftsInStore(params.assignmentStore, targets);
  return {
    store,
    clearedShiftIds: targets.map((t) => t.shiftId),
    hoursByIso,
  };
}

/** Unassign a single offered shift (callout / swap-style ref). */
export function clearOfferedShiftFromStore(
  store: AssignmentStore,
  shift: OfferedShiftRef
): AssignmentStore {
  return unassignShiftsInStore(store, [
    { restaurantId: shift.restaurantId, shiftId: shift.shiftId },
  ]);
}

export function buildLeaveEntriesForTimeoff(
  startIso: string,
  endIso: string,
  hoursByIso: Record<string, number>
): LeaveEntry[] {
  const entries: LeaveEntry[] = [];
  eachIsoDayInclusive(startIso, endIso, (iso) => {
    const h = hoursByIso[iso];
    entries.push({
      date: iso,
      hours: h != null && h > 0 ? Math.round(h * 100) / 100 : LEAVE_DEFAULT_DAY_HOURS,
    });
  });
  return entries;
}

export async function applyTimeoffApprovalEffects(
  sb: SupabaseClient,
  request: StaffRequestUi,
  emp: EmployeeRow,
  params: {
    assignmentStore: AssignmentStore;
    draftRows: DraftGrid;
    draftScheduleRaw?: unknown;
    employees: EmployeeRow[];
  }
): Promise<
  | { ok: true; store?: AssignmentStore }
  | { ok: false; message: string }
> {
  const range = parseTimeoffRequest(request);
  if (!range) {
    return { ok: false, message: 'This time-off request is missing a valid date range.' };
  }
  const workerName = employeeDisplayName(emp) || request.employeeName;
  const cleared = clearWorkerScheduleOnDateRange({
    employees: params.employees,
    workerName,
    emp,
    startIso: range.start,
    endIso: range.end,
    assignmentStore: params.assignmentStore || {},
    draftRows: params.draftRows,
    draftScheduleRaw: params.draftScheduleRaw,
  });

  const leaveEntries = buildLeaveEntriesForTimeoff(range.start, range.end, cleared.hoursByIso);
  appendLeaveBalanceEntries(emp, range.leaveType, leaveEntries);
  const saved = await saveEmployeeRow(sb, emp);
  if (!saved.ok) {
    return { ok: false, message: saved.message || 'Could not update leave balance.' };
  }

  try {
    await clearDayLeaveOverridesInRange(emp.id, range.start, range.end);
  } catch {
    /* non-blocking — leaveBalance still drives display */
  }

  if (cleared.clearedShiftIds.length) {
    const persisted = await persistAssignmentStore(sb, cleared.store);
    if (!persisted.ok) return persisted;
    return { ok: true, store: persisted.store };
  }
  return { ok: true, store: cleared.store };
}

export async function applyCalloutApprovalEffects(
  sb: SupabaseClient,
  request: StaffRequestUi,
  emp: EmployeeRow | null,
  params: {
    assignmentStore: AssignmentStore;
    draftRows: DraftGrid;
    draftScheduleRaw?: unknown;
    employees: EmployeeRow[];
  }
): Promise<
  | { ok: true; store?: AssignmentStore }
  | { ok: false; message: string }
> {
  const offered = resolveOfferedShiftRef(request);
  let nextStore = params.assignmentStore || {};
  let cleared = false;

  if (offered) {
    nextStore = clearOfferedShiftFromStore(nextStore, offered);
    cleared = true;
  } else if (emp || request.employeeName) {
    /* Legacy callouts without offeredShift: clear that worker's shifts on the iso day if known. */
    const iso = String(request.offeredShift?.iso || '').slice(0, 10);
    if (iso) {
      const workerName = emp ? employeeDisplayName(emp) : request.employeeName;
      const result = clearWorkerScheduleOnDateRange({
        employees: params.employees,
        workerName,
        startIso: iso,
        endIso: iso,
        assignmentStore: nextStore,
        draftRows: params.draftRows,
        draftScheduleRaw: params.draftScheduleRaw,
      });
      nextStore = result.store;
      cleared = result.clearedShiftIds.length > 0;
    }
  }

  if (cleared) {
    const persisted = await persistAssignmentStore(sb, nextStore);
    if (!persisted.ok) return persisted;
    return { ok: true, store: persisted.store };
  }
  /* Still approve even if we could not locate a shift — manager can unassign manually. */
  return { ok: true };
}
