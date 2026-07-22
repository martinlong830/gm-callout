/**
 * Per-week availability overlay — mirrors web `getEmployeeAvailabilityWeekEntry` /
 * `setEmployeeAvailabilityWeekEntry` (`meta.availabilityByWeek`).
 */
import { employeeDisplayName, type EmployeeRow } from './employees';
import { localTodayISO } from './schedule/engine';
import type { DraftGrid } from './schedule/types';
import type { StaffRequestUi } from './staffRequests';
import { normalizeWeeklyGrid, type WeeklyGridNormalized } from './weeklyAvailabilityMatrix';

/** draft | submitted (pending review) | approved | declined */
export type AvailabilityWeekStatus = 'draft' | 'submitted' | 'approved' | 'declined';

export type AvailabilityWeekEntry = {
  grid: WeeklyGridNormalized;
  status: AvailabilityWeekStatus;
  submittedAt: string | null;
};

export function normalizeAvailabilityWeekStatus(raw: unknown): AvailabilityWeekStatus {
  const s = String(raw || '')
    .trim()
    .toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'declined' || s === 'rejected' || s === 'denied') return 'declined';
  if (s === 'submitted' || s === 'pending') return 'submitted';
  return 'draft';
}

export function availabilityStatusLabel(status: AvailabilityWeekStatus): string {
  if (status === 'approved') return 'Approved';
  if (status === 'declined') return 'Declined';
  if (status === 'submitted') return 'Pending';
  return 'Draft';
}

export function cloneAvailabilityGrid(
  grid: unknown,
  staffType: string,
  draftRows: DraftGrid
): WeeklyGridNormalized {
  const raw =
    grid && typeof grid === 'object' ? (JSON.parse(JSON.stringify(grid)) as unknown) : {};
  return normalizeWeeklyGrid(raw, staffType, draftRows);
}

function ensureMeta(emp: EmployeeRow): Record<string, unknown> {
  if (emp.meta && typeof emp.meta === 'object') return { ...emp.meta };
  return {};
}

export function findStaffRequestAvailabilityForWeek(
  emp: EmployeeRow,
  weekIndex: number,
  staffRequests: StaffRequestUi[]
): StaffRequestUi | null {
  const nameKey = employeeDisplayName(emp).trim().toLowerCase();
  if (!nameKey) return null;
  let best: StaffRequestUi | null = null;
  for (const r of staffRequests) {
    if (!r || r.type !== 'availability') continue;
    if (r.submittedWeekIndex != null && Number(r.submittedWeekIndex) !== Number(weekIndex)) {
      continue;
    }
    const rn = String(r.employeeName || '')
      .trim()
      .toLowerCase();
    if (rn !== nameKey) continue;
    if (!r.submittedGrid) continue;
    if (!best) {
      best = r;
      continue;
    }
    const a = String(r.submittedAt || '');
    const b = String(best.submittedAt || '');
    if (a >= b) best = r;
  }
  return best;
}

export function getEmployeeAvailabilityWeekEntry(
  emp: EmployeeRow,
  weekIndex: number,
  draftRows: DraftGrid,
  staffRequests: StaffRequestUi[] = []
): AvailabilityWeekEntry {
  const st = emp.staffType || 'Kitchen';
  const meta = emp.meta && typeof emp.meta === 'object' ? emp.meta : {};
  const byWeek =
    meta.availabilityByWeek && typeof meta.availabilityByWeek === 'object'
      ? (meta.availabilityByWeek as Record<string, unknown>)
      : {};
  const stored = byWeek[String(weekIndex)];
  if (stored && typeof stored === 'object' && (stored as { grid?: unknown }).grid) {
    const s = stored as { grid: unknown; status?: string; submittedAt?: string | null };
    return {
      grid: cloneAvailabilityGrid(s.grid, st, draftRows),
      status: normalizeAvailabilityWeekStatus(s.status),
      submittedAt: s.submittedAt || null,
    };
  }
  const fromReq = findStaffRequestAvailabilityForWeek(emp, weekIndex, staffRequests);
  if (fromReq?.submittedGrid) {
    let reqStatus = normalizeAvailabilityWeekStatus(fromReq.status);
    if (reqStatus === 'draft') reqStatus = 'submitted';
    return {
      grid: cloneAvailabilityGrid(fromReq.submittedGrid, st, draftRows),
      status: reqStatus === 'approved' || reqStatus === 'declined' ? reqStatus : 'submitted',
      submittedAt: fromReq.submittedAt || null,
    };
  }
  return {
    grid: cloneAvailabilityGrid(emp.weeklyGrid, st, draftRows),
    status: 'draft',
    submittedAt: null,
  };
}

/** Immutable apply — returns a new employee row with meta (and optionally weeklyGrid) updated. */
export function applyAvailabilityWeekEntry(
  emp: EmployeeRow,
  weekIndex: number,
  entry: { grid: unknown; status?: string; submittedAt?: string | null },
  opts: { syncWeeklyGrid?: boolean; draftRows: DraftGrid; todayIso?: string }
): EmployeeRow {
  const st = emp.staffType || 'Kitchen';
  const status = normalizeAvailabilityWeekStatus(entry.status);
  const grid = cloneAvailabilityGrid(entry.grid, st, opts.draftRows);
  const today = opts.todayIso || localTodayISO();
  const keepSubmittedAt =
    status === 'submitted' || status === 'approved' || status === 'declined';
  const nextEntry: AvailabilityWeekEntry = {
    grid,
    status,
    submittedAt: keepSubmittedAt ? entry.submittedAt || today : null,
  };
  const meta = ensureMeta(emp);
  const prevByWeek =
    meta.availabilityByWeek && typeof meta.availabilityByWeek === 'object'
      ? { ...(meta.availabilityByWeek as Record<string, unknown>) }
      : {};
  prevByWeek[String(weekIndex)] = nextEntry;
  meta.availabilityByWeek = prevByWeek;
  const next: EmployeeRow = { ...emp, meta };
  if (opts.syncWeeklyGrid !== false) {
    next.weeklyGrid = grid as unknown as Record<string, unknown>;
  }
  return next;
}

export function listPendingAvailabilityEmployees(
  employees: EmployeeRow[],
  weekIndex: number,
  draftRows: DraftGrid,
  staffRequests: StaffRequestUi[] = []
): EmployeeRow[] {
  return employees
    .filter(
      (emp) =>
        getEmployeeAvailabilityWeekEntry(emp, weekIndex, draftRows, staffRequests).status ===
        'submitted'
    )
    .sort((a, b) =>
      employeeDisplayName(a).localeCompare(employeeDisplayName(b), undefined, {
        sensitivity: 'base',
      })
    );
}
