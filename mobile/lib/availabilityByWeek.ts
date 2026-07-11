/**
 * Per-week availability overlay — mirrors web `getEmployeeAvailabilityWeekEntry` /
 * `setEmployeeAvailabilityWeekEntry` (`meta.availabilityByWeek`).
 */
import { employeeDisplayName, type EmployeeRow } from './employees';
import { localTodayISO } from './schedule/engine';
import type { DraftGrid } from './schedule/types';
import type { StaffRequestUi } from './staffRequests';
import { normalizeWeeklyGrid, type WeeklyGridNormalized } from './weeklyAvailabilityMatrix';

export type AvailabilityWeekStatus = 'draft' | 'submitted';

export type AvailabilityWeekEntry = {
  grid: WeeklyGridNormalized;
  status: AvailabilityWeekStatus;
  submittedAt: string | null;
};

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
      status: s.status === 'submitted' ? 'submitted' : 'draft',
      submittedAt: s.submittedAt || null,
    };
  }
  const fromReq = findStaffRequestAvailabilityForWeek(emp, weekIndex, staffRequests);
  if (fromReq?.submittedGrid) {
    return {
      grid: cloneAvailabilityGrid(fromReq.submittedGrid, st, draftRows),
      status: 'submitted',
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
  const status: AvailabilityWeekStatus = entry.status === 'submitted' ? 'submitted' : 'draft';
  const grid = cloneAvailabilityGrid(entry.grid, st, opts.draftRows);
  const today = opts.todayIso || localTodayISO();
  const nextEntry: AvailabilityWeekEntry = {
    grid,
    status,
    submittedAt: status === 'submitted' ? entry.submittedAt || today : null,
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
