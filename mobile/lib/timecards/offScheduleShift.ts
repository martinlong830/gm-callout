import { formatCalendarDateLabel } from '../schedule/employeeShiftDisplay';
import type { WorkerShiftRow } from '../schedule/engine';
import { isoFromDate } from './payWeek';
import { isMidnightOnShiftDate } from './punch';
import {
  getEmployeeDayAdditionalCashTipSync,
  getEmployeeDayLeaveSync,
  leaveHoursFromBalanceForDay,
  type WeekExtrasSlice,
} from './weekExtras';
import type { PayWeekBounds, ShiftDayRow, TimeClockEntry } from './types';

const addedOffScheduleDaysByEmp: Record<string, string[]> = {};

export const OFF_SCHEDULE_SHIFT_ID_PREFIX = 'off-schedule:';

export function offScheduleShiftIdForIso(iso: string): string {
  return OFF_SCHEDULE_SHIFT_ID_PREFIX + iso;
}

export function isOffScheduleShiftId(id: string | null | undefined): boolean {
  return !!id && id.startsWith(OFF_SCHEDULE_SHIFT_ID_PREFIX);
}

export function isoFromOffScheduleShiftId(id: string): string | null {
  if (!isOffScheduleShiftId(id)) return null;
  return id.slice(OFF_SCHEDULE_SHIFT_ID_PREFIX.length) || null;
}

function punchDayIsoLocal(entry: TimeClockEntry): string {
  if (!entry?.clock_in_at) return '';
  return isoFromDate(new Date(entry.clock_in_at));
}

/** Ignore shift-day date placeholders (midnight clock-in with no real punch). */
export function entryHasMeaningfulPunch(entry: TimeClockEntry, punchIso?: string): boolean {
  if (!entry?.clock_in_at) return false;
  const iso = punchIso || punchDayIsoLocal(entry);
  if (!iso) return false;
  if (entry.clock_out_at) return true;
  if (entry.break_start_at || entry.break_end_at) return true;
  const dt = new Date(entry.clock_in_at);
  if (isMidnightOnShiftDate(dt, iso)) return false;
  return true;
}

export function makeOffScheduleShiftRow(iso: string): WorkerShiftRow {
  const day = formatCalendarDateLabel({ iso, day: '' });
  return {
    id: offScheduleShiftIdForIso(iso),
    day,
    iso,
    trIdx: 0,
    role: 'Server',
    roleClass: '',
    groupLabel: '',
    start: '',
    end: '',
    slotKey: '',
    timeLabel: 'Off schedule',
    redPokeBreak: '',
    redPokeHours: '0',
    workers: [],
    worker: '',
    restaurantId: '',
    restaurantName: '',
    dayNameUpper: day.split(',')[0]?.trim() ?? '',
  };
}

export function makeOffScheduleShiftDayRow(iso: string): ShiftDayRow {
  const todayIso = isoFromDate(new Date());
  return {
    shift: makeOffScheduleShiftRow(iso),
    iso,
    isToday: iso === todayIso,
    isUpcoming: iso > todayIso,
  };
}

export function isOffScheduleShiftDayRow(row: ShiftDayRow): boolean {
  return isOffScheduleShiftId(row.shift.id);
}

export type OffScheduleDaySources = {
  empId: string;
  bounds: PayWeekBounds;
  scheduledIsos: Set<string>;
  entries?: TimeClockEntry[];
  extrasSlice?: WeekExtrasSlice;
  dishwasherTipsSlice?: Record<string, number>;
  addedDayIsos?: string[];
  /** Optional: include leaveBalance / approved request days. */
  emp?: { id: string; meta?: { leaveBalance?: unknown }; firstName?: string; lastName?: string; displayName?: string };
  displayName?: string;
  staffRequests?: Array<{
    status?: string;
    type?: string;
    employeeName?: string;
    leaveType?: string;
    timeoffStart?: string;
    timeoffEnd?: string;
    summary?: string;
  }>;
};

export function collectOffScheduleDayIsos(params: OffScheduleDaySources): string[] {
  const {
    empId,
    bounds,
    scheduledIsos,
    entries,
    extrasSlice,
    dishwasherTipsSlice,
    addedDayIsos,
    emp,
    staffRequests,
  } = params;
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const found = new Set<string>();

  const maybeAdd = (iso: string) => {
    if (!iso || iso < weekStart || iso > weekEnd) return;
    if (scheduledIsos.has(iso)) return;
    found.add(iso);
  };

  for (const e of entries ?? []) {
    if (e.employee_id !== empId || !e.clock_in_at) continue;
    const punchIso = punchDayIsoLocal(e);
    if (!entryHasMeaningfulPunch(e, punchIso)) continue;
    maybeAdd(punchIso);
  }

  for (const k of Object.keys(extrasSlice ?? {})) {
    if (k.startsWith('acash|')) {
      const parts = k.split('|');
      if (parts.length >= 3 && parts[1] === empId) {
        const amount = extrasSlice![k];
        if (typeof amount === 'number' && amount > 0) maybeAdd(parts[2]);
      }
      continue;
    }
    const at = k.indexOf('@');
    if (at < 0 || k.slice(0, at) !== empId) continue;
    const row = extrasSlice![k];
    if (!row || typeof row !== 'object') continue;
    if ((parseFloat(String((row as { vl?: number }).vl)) || 0) <= 0 &&
        (parseFloat(String((row as { sl?: number }).sl)) || 0) <= 0) {
      continue;
    }
    maybeAdd(k.slice(at + 1));
  }

  for (const k of Object.keys(dishwasherTipsSlice ?? {})) {
    const tip = dishwasherTipsSlice![k];
    if (!(tip > 0)) continue;
    const parts = k.split('|');
    if (parts.length >= 3 && parts[1] === empId) maybeAdd(parts.slice(2).join('|'));
    else {
      const at = k.indexOf('@');
      if (at >= 0 && k.slice(0, at) === empId) maybeAdd(k.slice(at + 1));
    }
  }

  for (const iso of addedDayIsos ?? []) {
    maybeAdd(iso);
  }

  const bal = emp?.meta?.leaveBalance as
    | { vacation?: { entries?: { date?: string; hours?: number }[] }; sick?: { entries?: { date?: string; hours?: number }[] } }
    | undefined;
  if (bal) {
    for (const e of bal.vacation?.entries ?? []) {
      const dIso = String(e.date ?? '').slice(0, 10);
      if ((parseFloat(String(e.hours)) || 0) <= 0) continue;
      const override = extrasSlice?.[`${empId}@${dIso}`];
      if (override && typeof override === 'object' && (override as { manual?: boolean }).manual !== false) {
        continue;
      }
      maybeAdd(dIso);
    }
    for (const e of bal.sick?.entries ?? []) {
      const dIso = String(e.date ?? '').slice(0, 10);
      if ((parseFloat(String(e.hours)) || 0) <= 0) continue;
      const override = extrasSlice?.[`${empId}@${dIso}`];
      if (override && typeof override === 'object' && (override as { manual?: boolean }).manual !== false) {
        continue;
      }
      maybeAdd(dIso);
    }
  }

  if (emp && staffRequests?.length) {
    for (const req of staffRequests) {
      if (req.status !== 'approved' || req.type !== 'timeoff') continue;
      const summary = String(req.summary || '');
      let start = req.timeoffStart ? String(req.timeoffStart).slice(0, 10) : '';
      let end = req.timeoffEnd ? String(req.timeoffEnd).slice(0, 10) : '';
      const m = summary.match(
        /(?:Time Off|Vacation leave|Sick leave):\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i
      );
      if (m) {
        if (!start) start = m[1];
        if (!end) end = m[2];
      }
      if (!start || !end || end < start) continue;
      let cur = new Date(start + 'T12:00:00');
      const endD = new Date(end + 'T12:00:00');
      while (cur <= endD) {
        maybeAdd(isoFromDate(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }
  }

  return Array.from(found).sort();
}

export function getAddedOffScheduleDays(empId: string): string[] {
  return addedOffScheduleDaysByEmp[empId] ? [...addedOffScheduleDaysByEmp[empId]] : [];
}

export function addOffScheduleDay(empId: string, iso: string): void {
  if (!empId || !iso) return;
  const list = addedOffScheduleDaysByEmp[empId] ?? [];
  if (!list.includes(iso)) list.push(iso);
  addedOffScheduleDaysByEmp[empId] = list;
}

export function removeOffScheduleDay(empId: string, iso: string): void {
  if (!empId || !iso) return;
  const list = addedOffScheduleDaysByEmp[empId];
  if (!list?.length) return;
  addedOffScheduleDaysByEmp[empId] = list.filter((d) => d !== iso);
}

export type DayTimecardActivitySources = {
  empId: string;
  iso: string;
  entries?: TimeClockEntry[];
  extrasSlice?: WeekExtrasSlice;
  dishwasherTipsSlice?: Record<string, number>;
  addedDayIsos?: string[];
  emp?: { id: string; meta?: { leaveBalance?: unknown } };
};

export function dayHasTimecardActivity(params: DayTimecardActivitySources): boolean {
  const { empId, iso, entries, extrasSlice, dishwasherTipsSlice, addedDayIsos, emp } = params;
  if (!empId || !iso) return false;
  if ((addedDayIsos ?? getAddedOffScheduleDays(empId)).includes(iso)) return true;
  for (const e of entries ?? []) {
    if (e.employee_id !== empId || !e.clock_in_at) continue;
    if (punchDayIsoLocal(e) === iso && entryHasMeaningfulPunch(e, iso)) return true;
  }
  const leave = getEmployeeDayLeaveSync(empId, iso, extrasSlice ?? {});
  if (leave.vl > 0 || leave.sl > 0) return true;
  if (emp && emp.id === empId) {
    const fromBal = leaveHoursFromBalanceForDay(emp as Parameters<typeof leaveHoursFromBalanceForDay>[0], iso);
    if (fromBal.vl > 0 || fromBal.sl > 0) return true;
  }
  if (getEmployeeDayAdditionalCashTipSync(empId, iso, extrasSlice ?? {}) > 0) return true;
  for (const k of Object.keys(dishwasherTipsSlice ?? {})) {
    const tip = dishwasherTipsSlice![k];
    if (!(tip > 0)) continue;
    const parts = k.split('|');
    if (parts.length >= 3 && parts[1] === empId && parts.slice(2).join('|') === iso) return true;
    if (k === `${empId}@${iso}`) return true;
  }
  return false;
}

export function scheduleShiftIdForSave(shiftId: string): string | null {
  return isOffScheduleShiftId(shiftId) ? null : shiftId;
}

const PAY_WEEK_WK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PAY_WEEK_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function availableOffScheduleDayOptions(
  bounds: PayWeekBounds,
  existingIsos: Set<string>
): { iso: string; label: string }[] {
  const out: { iso: string; label: string }[] = [];
  for (let i = 0; i < 7; i++) {
    const dt = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), bounds.start.getDate() + i);
    const iso = isoFromDate(dt);
    if (existingIsos.has(iso)) continue;
    out.push({
      iso,
      label: `${PAY_WEEK_WK[i]} ${PAY_WEEK_MONTHS[dt.getMonth()]} ${dt.getDate()}`,
    });
  }
  return out;
}
