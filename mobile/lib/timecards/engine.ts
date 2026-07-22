import type { EmployeeRow } from '../employees';
import { employeeDisplayName, staffTypeLabel } from '../employees';
import type { StaffRequestUi } from '../staffRequests';
import {
  buildAllLocationsScheduleRows,
  buildAllLocationsWorkerShiftRows,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  indexPayWeekScheduleRows,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  assignmentShell,
  redPokeShiftHoursDecimal,
  redPokeShiftTimeLabel,
  scheduleWorkerNameKey,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  shiftRowIncludesWorker,
  weekIndexForPayWeekStartIso,
  type WorkerShiftRow,
} from '../schedule/engine';
import type { EmployeeLite } from '../schedule/types';
import { isoFromDate } from './payWeek';
import {
  isDeliveryDishwasherStaff,
  loadDishwasherTipsSlice,
  netTipAmount,
  sumEmployeeWeekDishwasherTipsSync,
} from './dishwasherTips';
import {
  getEmployeeWeekExtras,
  getEmployeeWeekExtrasSync,
  getEmployeeDayLeaveSync,
  leaveHoursFromBalanceForDay,
  loadWeekExtrasSlice,
  sumEmployeeWeekAdditionalCashTipsSync,
  type WeekExtrasSlice,
} from './weekExtras';
import { getSohRate } from './sohRate';
import {
  collectOffScheduleDayIsos,
  dayHasTimecardActivity,
  getAddedOffScheduleDays,
  isOffScheduleShiftDayRow,
  makeOffScheduleShiftDayRow,
  entryHasMeaningfulPunch,
} from './offScheduleShift';
import {
  punchShiftRoundedMinutes,
  scheduledShiftStartAt,
  formatPunchClock,
} from './punch';
import type {
  EmployeeClockStatus,
  PayWeekBounds,
  RosterRow,
  RosterTotals,
  ShiftDayRow,
  TimeClockEntry,
  WeekExtras,
} from './types';

import {
  resolveBreakPaid,
  unpaidBreakMinutes,
  formatBreakPolicyLabel,
} from './breakPolicy';
import { entryRestaurantId, punchDayRestaurantId, type LocationFilter } from './restaurantAttribution';

export type { RosterRow, RosterTotals, ShiftDayRow, WeekExtras, TimeClockEntry, PayWeekBounds, EmployeeClockStatus };

const OT_RATE_MULTIPLIER = 1.5;
const PAY_ROUND_MINUTES = 15;
/** First 40h of recorded work in the pay week are regular; remainder is overtime. */
export const WEEKLY_REGULAR_CAP_MINUTES = 40 * 60;
const SOH_THRESHOLD_MINUTES = 10 * 60;
const SOH_PAY_HOURS = 1;

const ROSTER_DEPT_RANK: Record<string, number> = { Bartender: 0, Kitchen: 1, Server: 2 };

export function decimalHoursFromMinutes(mins: number): string {
  const h = mins / 60;
  if (Math.abs(h - Math.round(h * 10) / 10) < 0.01) {
    return (Math.round(h * 10) / 10).toFixed(1);
  }
  return (Math.round(h * 100) / 100).toFixed(2);
}

export function formatPayAmount(amount: number | null | undefined): string {
  if (amount == null || Number.isNaN(amount)) return '—';
  return `$${amount.toFixed(2)}`;
}

export function formatHourlyRateLabel(emp: EmployeeRow): string {
  if (emp.hourlyRate == null || Number.isNaN(Number(emp.hourlyRate))) return '—';
  const r = Number(emp.hourlyRate);
  if (r < 0) return '—';
  return `${formatPayAmount(r)}/hr`;
}

function parseScheduledHoursDecimal(shift: WorkerShiftRow): number {
  if (shift.redPokeHours != null && shift.redPokeHours !== '') {
    return parseFloat(String(shift.redPokeHours)) || 0;
  }
  return parseFloat(redPokeShiftHoursDecimal(shift.start, shift.end)) || 0;
}

export function parseBreakMinutesFromAnnotation(text: string | undefined): number {
  const s = String(text || '').toLowerCase();
  const m = s.match(/(\d+)\s*(?:min|minute)/);
  if (m) return parseInt(m[1], 10) || 0;
  if (s.includes('break') && !s.includes('no')) return 30;
  return 0;
}

/** Shifts of 6 hours or less use full scheduled span; longer shifts deduct unpaid break. */
const SHORT_SHIFT_NO_BREAK_DEDUCT_MINUTES = 6 * 60;

export function scheduledPaidMinutes(shift: WorkerShiftRow, emp?: EmployeeRow | null): number {
  const gross = Math.round(parseScheduledHoursDecimal(shift) * 60);
  if (gross <= SHORT_SHIFT_NO_BREAK_DEDUCT_MINUTES) return gross;
  const br = parseBreakMinutesFromAnnotation(shift.redPokeBreak);
  const isPaid = resolveBreakPaid({ shift, emp: emp ?? null });
  return Math.max(0, gross - unpaidBreakMinutes(br, isPaid));
}

export function roundToNearest5Minutes(mins: number): number {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return Math.round(m / 5) * 5;
}

function roundToNearest15Minutes(mins: number): number {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return Math.round(m / PAY_ROUND_MINUTES) * PAY_ROUND_MINUTES;
}

export type RegOtMinutes = { regMins: number; otMins: number; totalMins: number };

/** Split recorded minutes using remaining weekly regular allowance (chronological). */
export function allocateRecordedRegOtMinutes(
  recordedMins: number,
  regularRemaining: number
): RegOtMinutes & { regularRemaining: number } {
  const rec = roundToNearest15Minutes(recordedMins);
  const regMins = Math.min(rec, Math.max(0, regularRemaining));
  const otMins = rec - regMins;
  return {
    regMins,
    otMins,
    totalMins: regMins + otMins,
    regularRemaining: regularRemaining - regMins,
  };
}

/** Allocate reg/OT by calendar day (ascending ISO) within the pay week. */
export function weeklyRegOtByDay(
  dayRecorded: Array<{ iso: string; recordedMins: number }>
): Record<string, RegOtMinutes> {
  let regularRemaining = WEEKLY_REGULAR_CAP_MINUTES;
  const out: Record<string, RegOtMinutes> = {};
  const sorted = [...dayRecorded].sort((a, b) => a.iso.localeCompare(b.iso));
  for (const day of sorted) {
    const split = allocateRecordedRegOtMinutes(day.recordedMins, regularRemaining);
    regularRemaining = split.regularRemaining;
    out[day.iso] = { regMins: split.regMins, otMins: split.otMins, totalMins: split.totalMins };
  }
  return out;
}

export function weekDayRecordedForEmployee(
  shifts: ShiftDayRow[],
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  entriesIndex?: Record<string, TimeClockEntry[]>,
  scheduleCtx?: ScheduleContext,
  locationFilter: LocationFilter = 'all'
): Array<{ iso: string; recordedMins: number }> {
  if (!scheduleCtx) {
    const seen = new Set<string>();
    const dayRecorded: Array<{ iso: string; recordedMins: number }> = [];
    for (const row of shifts) {
      if (seen.has(row.iso)) continue;
      const dayEntries = entriesIndex
        ? findEntriesForDayIndexed(entriesIndex, emp.id, row.iso)
        : findEntriesForDay(entries, emp.id, row.iso);
      if (!dayEntries.length) continue;
      seen.add(row.iso);
      dayRecorded.push({
        iso: row.iso,
        recordedMins: dailyRecordedMinutesForEmployee(entries, emp.id, row.iso, emp),
      });
    }
    return dayRecorded;
  }
  const byIso: Record<string, number> = {};
  for (const e of entries) {
    if (e.employee_id !== emp.id || !e.clock_in_at) continue;
    const iso = punchDayIso(e);
    if (!entryHasMeaningfulPunch(e, iso)) continue;
    if (locationFilter !== 'all' && entryRestaurantId(emp, e, entries, scheduleCtx) !== locationFilter) {
      continue;
    }
    byIso[iso] = (byIso[iso] || 0) + recordedPaidMinutes(e, null, emp);
  }
  return Object.keys(byIso)
    .sort()
    .map((iso) => ({ iso, recordedMins: byIso[iso] }));
}

/** @deprecated Use weekly reg/OT allocation; schedMins is ignored. */
export function shiftRegularOvertimeMinutes(_schedMins: number, recordedMins: number) {
  const split = allocateRecordedRegOtMinutes(recordedMins, WEEKLY_REGULAR_CAP_MINUTES);
  return { regMins: split.regMins, otMins: split.otMins, totalMins: split.totalMins };
}

function employeeHourlyRate(emp: EmployeeRow): number | null {
  if (emp.hourlyRate == null || Number.isNaN(Number(emp.hourlyRate))) return null;
  const r = Number(emp.hourlyRate);
  return r >= 0 ? r : null;
}

function leavePayFromHours(emp: EmployeeRow, hours: number): number {
  const h = Number(hours);
  if (!h || h <= 0) return 0;
  const rate = employeeHourlyRate(emp);
  if (rate == null) return 0;
  return h * rate;
}

export function payFromRegOtMinutes(emp: EmployeeRow, regMins: number, otMins: number) {
  const rate = employeeHourlyRate(emp);
  if (rate == null) return { regPay: null as number | null, otPay: null as number | null, totalPay: null as number | null };
  const regPay = (regMins / 60) * rate;
  const otPay = (otMins / 60) * rate * OT_RATE_MULTIPLIER;
  return { regPay, otPay, totalPay: regPay + otPay };
}

export function dayPayInPayWeek(
  emp: EmployeeRow,
  dayRecorded: Array<{ iso: string; recordedMins: number }>,
  targetIso: string
) {
  const byDay = weeklyRegOtByDay(dayRecorded);
  const split = byDay[targetIso] || { regMins: 0, otMins: 0, totalMins: 0 };
  const pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
  return { ...split, ...pay };
}

export function weekDayRecordedByRestaurantForEmployee(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  locationFilter: LocationFilter = 'all'
): Array<{ iso: string; restaurantId: string; recordedMins: number }> {
  const buckets: Record<string, number> = {};
  for (const e of entries) {
    if (e.employee_id !== emp.id || !e.clock_in_at) continue;
    const iso = punchDayIso(e);
    if (!entryHasMeaningfulPunch(e, iso)) continue;
    const rest = entryRestaurantId(emp, e, entries, scheduleCtx);
    if (locationFilter !== 'all' && rest !== locationFilter) continue;
    const key = `${iso}\0${rest}`;
    buckets[key] = (buckets[key] || 0) + recordedPaidMinutes(e, null, emp);
  }
  return Object.keys(buckets)
    .sort()
    .map((key) => {
      const sep = key.indexOf('\0');
      return {
        iso: key.slice(0, sep),
        restaurantId: key.slice(sep + 1),
        recordedMins: buckets[key],
      };
    });
}

export function weeklyRegOtByRestaurantDay(
  buckets: Array<{ iso: string; restaurantId: string; recordedMins: number }>
): Record<string, RegOtMinutes> {
  const sorted = [...buckets].sort((a, b) => {
    if (a.iso !== b.iso) return a.iso.localeCompare(b.iso);
    return a.restaurantId.localeCompare(b.restaurantId);
  });
  let regularRemaining = WEEKLY_REGULAR_CAP_MINUTES;
  const out: Record<string, RegOtMinutes> = {};
  for (const b of sorted) {
    const split = allocateRecordedRegOtMinutes(b.recordedMins, regularRemaining);
    regularRemaining = split.regularRemaining;
    out[`${b.iso}\0${b.restaurantId}`] = {
      regMins: split.regMins,
      otMins: split.otMins,
      totalMins: split.totalMins,
    };
  }
  return out;
}

export function shiftRowAttributionRestaurant(
  emp: EmployeeRow,
  row: ShiftDayRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext
): string {
  if (isOffScheduleShiftDayRow(row)) {
    return punchDayRestaurantId(emp, row.iso, entries, scheduleCtx);
  }
  return shiftRestaurantId(row.shift);
}

export function dailyRecordedMinutesForEmployeeAtRestaurant(
  emp: EmployeeRow,
  iso: string,
  restaurantId: string,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext
): number {
  let total = 0;
  for (const e of findEntriesForDay(entries, emp.id, iso)) {
    if (!e.clock_in_at) continue;
    if (entryRestaurantId(emp, e, entries, scheduleCtx) !== restaurantId) continue;
    total += recordedPaidMinutes(e, null, emp);
  }
  return total;
}

/**
 * Prefer store-attributed punches; when this is the only scheduled shift that day and
 * attribution left punches stranded, count the day's meaningful punches so manual logs show pay.
 */
export function dailyRecordedMinutesForShiftRow(
  emp: EmployeeRow,
  row: ShiftDayRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext
): number {
  const rowRest = shiftRowAttributionRestaurant(emp, row, entries, scheduleCtx);
  const attributed = dailyRecordedMinutesForEmployeeAtRestaurant(
    emp,
    row.iso,
    rowRest,
    entries,
    scheduleCtx
  );
  if (attributed > 0) return attributed;
  if (isOffScheduleShiftDayRow(row)) {
    let offTotal = 0;
    for (const e of findEntriesForDay(entries, emp.id, row.iso)) {
      if (!entryHasMeaningfulPunch(e, row.iso)) continue;
      offTotal += recordedPaidMinutes(e, null, emp);
    }
    return offTotal;
  }
  const name = employeeDisplayName(emp);
  const byWorker = scheduleCtx.payWeekShiftsByWorkerKey;
  let scheduledSameDay = 0;
  if (byWorker) {
    const list = byWorker[scheduleWorkerNameKey(name)] || [];
    scheduledSameDay = list.filter(
      (s) => s.iso === row.iso && shiftRowIncludesWorker(s, name)
    ).length;
  }
  if (scheduledSameDay > 1) return attributed;
  let total = 0;
  for (const e of findEntriesForDay(entries, emp.id, row.iso)) {
    if (!entryHasMeaningfulPunch(e, row.iso)) continue;
    total += recordedPaidMinutes(e, null, emp);
  }
  return total;
}

export function weekRegOtForShiftRow(
  emp: EmployeeRow,
  row: ShiftDayRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  locationFilter: LocationFilter = 'all'
): RegOtMinutes {
  const byRest = weeklyRegOtByRestaurantDay(
    weekDayRecordedByRestaurantForEmployee(emp, entries, scheduleCtx, locationFilter)
  );
  const rest = shiftRowAttributionRestaurant(emp, row, entries, scheduleCtx);
  const hit = byRest[`${row.iso}\0${rest}`];
  if (hit && hit.totalMins > 0) return hit;
  const fallbackMins = dailyRecordedMinutesForShiftRow(emp, row, entries, scheduleCtx);
  if (fallbackMins <= 0) return hit || { regMins: 0, otMins: 0, totalMins: 0 };
  const byDay = weeklyRegOtByDay(
    weekDayRecordedForEmployee([], emp, entries, undefined, scheduleCtx, locationFilter)
  );
  return byDay[row.iso] || { regMins: 0, otMins: 0, totalMins: 0 };
}

export function shiftPayForShiftRow(
  emp: EmployeeRow,
  row: ShiftDayRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  locationFilter: LocationFilter = 'all'
) {
  const split = weekRegOtForShiftRow(emp, row, entries, scheduleCtx, locationFilter);
  const pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
  return { ...split, ...pay };
}

/** @deprecated Use dayPayInPayWeek for week-aware reg/OT; schedMins is ignored. */
export function shiftPayForScheduledRecorded(emp: EmployeeRow, _schedMins: number, recordedMins: number) {
  const split = allocateRecordedRegOtMinutes(recordedMins, WEEKLY_REGULAR_CAP_MINUTES);
  const pay = payFromRegOtMinutes(emp, split.regMins, split.otMins);
  return { ...split, ...pay };
}

export function formatShiftPayLabel(pay: {
  regPay: number | null;
  otPay: number | null;
  totalPay: number | null;
}): string {
  if (pay.totalPay == null) return '—';
  if ((pay.otPay || 0) > 0.005) {
    return `${formatPayAmount(pay.totalPay)} (${formatPayAmount(pay.regPay)} reg · ${formatPayAmount(pay.otPay)} OT)`;
  }
  return formatPayAmount(pay.totalPay);
}

export function punchDayIso(entry: TimeClockEntry): string {
  return isoFromDate(new Date(entry.clock_in_at));
}

export function isEntryOpen(entry: TimeClockEntry | null | undefined): boolean {
  return !!entry && !entry.clock_out_at;
}

export function isOnBreak(entry: TimeClockEntry | null | undefined): boolean {
  return !!(entry && entry.break_start_at && !entry.break_end_at);
}

export const CLOCK_STATUS_LABELS: Record<EmployeeClockStatus, string> = {
  clocked_in: 'Clocked in',
  on_break: 'On break',
  off_clock: 'Not on clock',
};

export const CLOCK_STATUS_RANK: Record<EmployeeClockStatus, number> = {
  on_break: 0,
  clocked_in: 1,
  off_clock: 2,
};

export function findLatestOpenEntryForEmployee(
  entries: TimeClockEntry[],
  empId: string
): TimeClockEntry | null {
  let latest: TimeClockEntry | null = null;
  for (const e of entries) {
    if (e.employee_id !== empId || !isEntryOpen(e)) continue;
    if (!latest || String(e.clock_in_at).localeCompare(String(latest.clock_in_at)) > 0) {
      latest = e;
    }
  }
  return latest;
}

export function employeeClockStatus(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  locationFilter: LocationFilter = 'all'
): EmployeeClockStatus {
  const open = findLatestOpenEntryForEmployee(entries, emp.id);
  if (!open) return 'off_clock';
  if (locationFilter !== 'all') {
    const rest = entryRestaurantId(emp, open, entries, scheduleCtx);
    if (rest !== locationFilter) return 'off_clock';
  }
  return isOnBreak(open) ? 'on_break' : 'clocked_in';
}

export function breakMinutesFromRange(
  startIso: string | null | undefined,
  endIso: string | null | undefined,
  clockOutIso?: string | null
): number {
  if (!startIso) return 0;
  const startTs = new Date(startIso).getTime();
  if (Number.isNaN(startTs)) return 0;
  let endTs: number;
  if (endIso) {
    endTs = new Date(endIso).getTime();
  } else if (clockOutIso) {
    endTs = new Date(clockOutIso).getTime();
  } else {
    endTs = Date.now();
  }
  if (Number.isNaN(endTs) || endTs <= startTs) return 0;
  return Math.max(0, Math.floor((endTs - startTs) / 60000));
}

function breakMinutesOverlappingWallTsRange(
  entry: TimeClockEntry,
  rangeStartTs: number,
  rangeEndTs: number
): number {
  if (rangeEndTs <= rangeStartTs) return 0;
  let total = 0;
  const segs = entry.break_segments;
  if (Array.isArray(segs)) {
    segs.forEach((seg) => {
      if (!seg?.start) return;
      const segStart = new Date(seg.start).getTime();
      const segEnd = new Date(seg.end || entry.clock_out_at || 0).getTime();
      if (Number.isNaN(segStart) || Number.isNaN(segEnd) || segEnd <= segStart) return;
      const start = Math.max(segStart, rangeStartTs);
      const end = Math.min(segEnd, rangeEndTs);
      if (end > start) total += Math.floor((end - start) / 60000);
    });
  }
  if (entry.break_start_at) {
    const brStart = new Date(entry.break_start_at).getTime();
    const brEnd = new Date(entry.break_end_at || entry.clock_out_at || 0).getTime();
    if (!Number.isNaN(brStart) && !Number.isNaN(brEnd) && brEnd > brStart) {
      const overlapStart = Math.max(brStart, rangeStartTs);
      const overlapEnd = Math.min(brEnd, rangeEndTs);
      if (overlapEnd > overlapStart) total += Math.floor((overlapEnd - overlapStart) / 60000);
    }
  }
  let stored = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
  if (Number.isNaN(stored)) stored = 0;
  if (
    stored > 0 &&
    !entry.break_start_at &&
    !(Array.isArray(segs) && segs.length) &&
    entry.clock_out_at
  ) {
    const outTs = new Date(entry.clock_out_at).getTime();
    if (!Number.isNaN(outTs)) {
      const assumedBreakStart = outTs - stored * 60000;
      const assumedStart = Math.max(assumedBreakStart, rangeStartTs);
      const assumedEnd = Math.min(outTs, rangeEndTs);
      if (assumedEnd > assumedStart) total += Math.floor((assumedEnd - assumedStart) / 60000);
    }
  }
  return total;
}

function sohWallClockThresholdTs(entry: TimeClockEntry): number | null {
  if (!entry.clock_in_at) return null;
  const inTs = new Date(entry.clock_in_at).getTime();
  if (Number.isNaN(inTs)) return null;
  return inTs + SOH_THRESHOLD_MINUTES * 60000;
}

/** True when paid work (not break-only) continues after clock-in + 10h wall-clock. */
export function entryExtendsPaidWorkPastSohThreshold(
  entry: TimeClockEntry,
  shiftRow?: ShiftDayRow | null,
  emp?: EmployeeRow | null
): boolean {
  if (!entry.clock_in_at || !entry.clock_out_at) return false;
  if (isStaleOpenPunch(entry)) return false;
  const thresholdTs = sohWallClockThresholdTs(entry);
  if (thresholdTs == null) return false;
  let outTs = new Date(entry.clock_out_at).getTime();
  if (Number.isNaN(outTs) || outTs <= thresholdTs) return false;
  const dayEnd = endOfLocalDayFromIso(punchDayIso(entry));
  if (dayEnd && outTs > dayEnd.getTime()) outTs = dayEnd.getTime();
  if (outTs <= thresholdTs) return false;
  const postWallMins = Math.floor((outTs - thresholdTs) / 60000);
  if (postWallMins <= 0) return false;
  const breakMins = breakMinutesOverlappingWallTsRange(entry, thresholdTs, outTs);
  const isPaid = resolveBreakPaid({ entry, shift: shiftRow?.shift, emp: emp ?? null });
  const unpaidBreak = unpaidBreakMinutes(breakMins, isPaid);
  return postWallMins > unpaidBreak;
}

/**
 * SoH day qualifies when span > 10h and either worked > 10h or paid work extends past the
 * 10h wall-clock point (break-only padding past 10h does not qualify).
 * Juan 11:30–22:00 (10.5h span) → qualifies unless break fills 21:30–22:00 with no work after.
 */
export function dayQualifiesForSpreadOfHours(
  workedMinutesRounded: number,
  spanMinutes: number,
  hasPaidWorkPastThreshold: boolean
): boolean {
  if (spanMinutes <= SOH_THRESHOLD_MINUTES) return false;
  return workedMinutesRounded > SOH_THRESHOLD_MINUTES || hasPaidWorkPastThreshold;
}

export function effectiveBreakMinutes(entry: TimeClockEntry): number {
  let stored = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
  if (Number.isNaN(stored)) stored = 0;
  if (isOnBreak(entry)) {
    return stored + breakMinutesFromRange(entry.break_start_at, null, entry.clock_out_at);
  }
  if (stored > 0) return stored;
  return breakMinutesFromRange(entry.break_start_at, entry.break_end_at, entry.clock_out_at);
}

function breakSegmentLines(entry: TimeClockEntry): string[] {
  const lines: string[] = [];
  const segs = entry.break_segments;
  if (Array.isArray(segs)) {
    segs.forEach((seg) => {
      if (!seg || !seg.start) return;
      if (seg.end) {
        lines.push(`${formatPunchClock(seg.start)} – ${formatPunchClock(seg.end)}`);
      }
    });
  }
  return lines;
}

export function formatBreakRangeLabel(entry: TimeClockEntry): string {
  const lines = breakSegmentLines(entry);
  if (isOnBreak(entry)) {
    lines.push(`${formatPunchClock(entry.break_start_at!)} – on break`);
  } else if (entry.break_start_at && entry.break_end_at) {
    const last = `${formatPunchClock(entry.break_start_at)} – ${formatPunchClock(entry.break_end_at)}`;
    if (!lines.includes(last)) lines.push(last);
  }
  if (lines.length) return `\nBreak ${lines.join('; ')}`;
  const mins = effectiveBreakMinutes(entry);
  return mins > 0 ? `\nBreak ${mins} min total` : '';
}

/** Open punch from a prior day — never clocked out; don't accrue hours until closed. */
export function isStaleOpenPunch(entry: TimeClockEntry): boolean {
  return isEntryOpen(entry) && punchDayIso(entry) !== isoFromDate(new Date());
}

function endOfLocalDayFromIso(iso: string): Date | null {
  const p = String(iso || '').split('-');
  if (p.length !== 3) return null;
  const d = new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10) + 1);
  d.setMilliseconds(d.getMilliseconds() - 1);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Paid minutes on the clock-in calendar day only (Spread of Hours). */
export function recordedPaidMinutesOnClockInDay(
  entry: TimeClockEntry,
  shiftRow?: ShiftDayRow | null,
  emp?: EmployeeRow | null
): number {
  if (!entry.clock_in_at) return 0;
  if (isStaleOpenPunch(entry)) return 0;
  const dayIso = punchDayIso(entry);
  const dayEnd = endOfLocalDayFromIso(dayIso);
  let outIso = entry.clock_out_at;
  if (dayEnd) {
    if (outIso) {
      const outD = new Date(outIso);
      if (outD.getTime() > dayEnd.getTime()) outIso = dayEnd.toISOString();
    } else {
      const now = new Date();
      outIso = (now.getTime() > dayEnd.getTime() ? dayEnd : now).toISOString();
    }
  }
  const shiftStart = shiftRow ? scheduledShiftStartAt(shiftRow.iso, shiftRow.shift.start) : null;
  const gross = punchShiftRoundedMinutes(entry.clock_in_at, outIso, shiftStart);
  const br = effectiveBreakMinutes(entry);
  const isPaid = resolveBreakPaid({ entry, shift: shiftRow?.shift, emp: emp ?? null });
  return Math.max(0, gross - unpaidBreakMinutes(br, isPaid));
}

/** Wall-clock span (clock-in to clock-out, breaks included) attributed to the clock-in day. */
export function recordedSpanMinutesOnClockInDay(entry: TimeClockEntry): number {
  if (!entry.clock_in_at || !entry.clock_out_at) return 0;
  if (isStaleOpenPunch(entry)) return 0;
  const inTs = new Date(entry.clock_in_at).getTime();
  let outTs = new Date(entry.clock_out_at).getTime();
  if (Number.isNaN(inTs) || Number.isNaN(outTs)) return 0;
  const dayEnd = endOfLocalDayFromIso(punchDayIso(entry));
  if (dayEnd && outTs > dayEnd.getTime()) outTs = dayEnd.getTime();
  return Math.max(0, Math.floor((outTs - inTs) / 60000));
}

export function recordedPaidMinutes(
  entry: TimeClockEntry,
  shiftRow?: ShiftDayRow | null,
  emp?: EmployeeRow | null
): number {
  if (isStaleOpenPunch(entry)) return 0;
  const shiftStart = shiftRow ? scheduledShiftStartAt(shiftRow.iso, shiftRow.shift.start) : null;
  const gross = punchShiftRoundedMinutes(entry.clock_in_at, entry.clock_out_at, shiftStart);
  const br = effectiveBreakMinutes(entry);
  const isPaid = resolveBreakPaid({ entry, shift: shiftRow?.shift, emp: emp ?? null });
  return Math.max(0, gross - unpaidBreakMinutes(br, isPaid));
}

export function findEntriesForDay(entries: TimeClockEntry[], empId: string, shiftIso: string): TimeClockEntry[] {
  return entries.filter(
    (e) => e.employee_id === empId && e.clock_in_at && punchDayIso(e) === shiftIso
  );
}

/** Punch rows to clear for a shift day (calendar day + schedule_shift_id link). */
export function entriesForShiftDayCleanup(
  entries: TimeClockEntry[],
  empId: string,
  shiftRow: ShiftDayRow,
  extraEntryIds?: string[],
  emp?: EmployeeRow | null,
  scheduleCtx?: ScheduleContext
): TimeClockEntry[] {
  const byId = new Map<string, TimeClockEntry>();
  for (const e of findEntriesForDay(entries, empId, shiftRow.iso)) {
    if (e?.id) byId.set(e.id, e);
  }
  if (!isOffScheduleShiftDayRow(shiftRow) && shiftRow.shift?.id) {
    const shiftId = shiftRow.shift.id;
    const rowRest = shiftRow.shift.restaurantId || 'rp-9';
    for (const e of entries) {
      if (e?.employee_id !== empId || e.schedule_shift_id !== shiftId || !e.id) continue;
      if (emp && scheduleCtx && entryRestaurantId(emp, e, entries, scheduleCtx) !== rowRest) continue;
      byId.set(e.id, e);
    }
  }
  for (const id of extraEntryIds || []) {
    if (!id || byId.has(id)) continue;
    const found = entries.find((e) => e?.id === id && e.employee_id === empId);
    if (found) byId.set(id, found);
  }
  return [...byId.values()];
}

export function formatRecordedHoursLabel(dayMins: number): string {
  return `${decimalHoursFromMinutes(roundToNearest5Minutes(dayMins || 0))}h`;
}

function statusSortRank(status: string): number {
  if (status === 'OK') return 0;
  if (status === 'Open') return 1;
  if (status === 'Review') return 2;
  return 3;
}

export function shiftStatusLabelForDay(
  shift: WorkerShiftRow,
  empId: string,
  shiftIso: string,
  entries: TimeClockEntry[],
  emp?: EmployeeRow | null
): string {
  const dayEntries = findEntriesForDay(entries, empId, shiftIso);
  if (!dayEntries.length) return 'No punch';
  if (dayEntries.some(isEntryOpen)) return 'Open';
  const sched = scheduledPaidMinutes(shift, emp);
  const rec = dayEntries.reduce((sum, e) => sum + recordedPaidMinutes(e, { shift, iso: shiftIso, isToday: false, isUpcoming: false }, emp), 0);
  if (Math.abs(sched - rec) <= 15) return 'OK';
  return 'Review';
}

export function statusColor(status: string): { bg: string; text: string } {
  if (status === 'OK') return { bg: '#dcfce7', text: '#166534' };
  if (status === 'Open') return { bg: '#dbeafe', text: '#1e40af' };
  if (status === 'Review') return { bg: '#fef3c7', text: '#92400e' };
  return { bg: '#f1f5f9', text: '#64748b' };
}

export type BuildScheduleContextOpts = {
  /** Scope schedule snapshot to this pay week (matches web timecards path). */
  bounds?: PayWeekBounds;
  employees?: EmployeeLite[];
};

export function buildScheduleContext(
  teamState: Record<string, unknown> | null,
  opts?: BuildScheduleContextOpts
) {
  const weekMeta = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate());
  const allWeekDays = weekMeta.map((m) => m.label);
  const draftScheduleRaw = teamState?.draft_schedule;
  const draftRows = loadDraftFromTeamState(draftScheduleRaw, SCHEDULE_TEMPLATE_WEEK_INDEX);
  const restaurants = defaultRestaurants();
  const assignmentStore = mergeRemoteAssignments(
    assignmentShell(restaurants),
    teamState?.schedule_assignments as Parameters<typeof mergeRemoteAssignments>[1],
    restaurants.map((r) => r.id)
  );
  const employees = opts?.employees ?? [];
  const bounds = opts?.bounds;
  let payWeekStartIso: string | null = null;
  let payWeekShiftsByWorkerKey: Record<string, WorkerShiftRow[]> | null = null;
  let payWeekShiftById: Record<string, WorkerShiftRow> | null = null;

  if (bounds) {
    payWeekStartIso = isoFromDate(bounds.start);
    const weekIdx = weekIndexForPayWeekStartIso(weekMeta, payWeekStartIso);
    const endIso = isoFromDate(bounds.end);
    const rows = buildAllLocationsScheduleRows(weekMeta, {
      allWeekDays,
      draftScheduleRaw,
      draftRows,
      employees,
      restaurants,
      assignmentStore,
      weekIndex: weekIdx,
    }).filter((s) => s.iso && s.iso >= payWeekStartIso! && s.iso <= endIso);
    const indexed = indexPayWeekScheduleRows(rows);
    payWeekShiftsByWorkerKey = indexed.byWorkerKey;
    payWeekShiftById = indexed.byId;
  }

  return {
    weekMeta,
    allWeekDays,
    draftScheduleRaw,
    draftRows,
    restaurants,
    assignmentStore,
    payWeekStartIso,
    payWeekShiftsByWorkerKey,
    payWeekShiftById,
  };
}

export type ScheduleContext = ReturnType<typeof buildScheduleContext>;

/** Worker schedule rows from pay-week index when available; otherwise full rebuild. */
export function getWorkerScheduleShiftsForContext(
  emp: EmployeeRow | { id?: string; firstName?: string; lastName?: string; displayName?: string; meta?: EmployeeRow['meta'] },
  scheduleCtx: ScheduleContext,
  employeesLite: EmployeeLite[],
  bounds: PayWeekBounds
): WorkerShiftRow[] {
  const name = employeeDisplayName(emp as EmployeeRow);
  const startIso = isoFromDate(bounds.start);
  const endIso = isoFromDate(bounds.end);
  const byWorker = scheduleCtx.payWeekShiftsByWorkerKey;
  const indexMatchesWeek =
    !!byWorker && scheduleCtx.payWeekStartIso != null && scheduleCtx.payWeekStartIso === startIso;

  if (indexMatchesWeek) {
    const seen = new Set<string>();
    const out: WorkerShiftRow[] = [];
    const consider = (list: WorkerShiftRow[] | undefined) => {
      for (const s of list || []) {
        if (!shiftRowIncludesWorker(s, name)) continue;
        if (s.iso < startIso || s.iso > endIso) continue;
        const id = `${s.id}\0${s.iso}\0${s.restaurantId}`;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(s);
      }
    };
    consider(byWorker[scheduleWorkerNameKey(name)]);
    const aliases = (emp as EmployeeRow).meta?.scheduleAliases;
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        consider(byWorker[scheduleWorkerNameKey(String(alias || ''))]);
      }
    }
    if (out.length) return out;
  }

  const { weekMeta, allWeekDays, draftScheduleRaw, draftRows, restaurants, assignmentStore } =
    scheduleCtx;
  const weekIdx = weekIndexForPayWeekStartIso(weekMeta, startIso);
  return buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftScheduleRaw,
    draftRows,
    employees: employeesLite,
    restaurants,
    assignmentStore,
    workerName: name,
    weekIndex: weekIdx,
  }).filter((s) => s.iso >= startIso && s.iso <= endIso);
}

export function buildEntriesIndex(entries: TimeClockEntry[]): Record<string, TimeClockEntry[]> {
  const byEmpDay: Record<string, TimeClockEntry[]> = {};
  for (const e of entries) {
    if (!e.employee_id || !e.clock_in_at) continue;
    const iso = punchDayIso(e);
    if (!iso) continue;
    const key = `${e.employee_id}\0${iso}`;
    if (!byEmpDay[key]) byEmpDay[key] = [];
    byEmpDay[key].push(e);
  }
  return byEmpDay;
}

function findEntriesForDayIndexed(
  index: Record<string, TimeClockEntry[]>,
  empId: string,
  shiftIso: string
): TimeClockEntry[] {
  return index[`${empId}\0${shiftIso}`] || [];
}

export type BuildShiftsOptions = {
  entries?: TimeClockEntry[];
  extrasSlice?: WeekExtrasSlice;
  dishwasherTipsSlice?: Record<string, number>;
  addedDayIsos?: string[];
  staffRequests?: StaffRequestUi[];
};

/** Scheduled paid minutes by day (all schedule rows in pay week, not activity-filtered). */
export function buildScheduledMinutesByDayForEmployee(
  emp: EmployeeRow,
  teamState: Record<string, unknown> | null,
  employees: EmployeeLite[],
  bounds: PayWeekBounds,
  cachedCtx?: ScheduleContext
): Record<string, number> {
  const scheduleCtx =
    cachedCtx ?? buildScheduleContext(teamState, { bounds, employees });
  const all = getWorkerScheduleShiftsForContext(emp, scheduleCtx, employees, bounds);
  const map: Record<string, number> = {};
  for (const s of all) {
    if (!s.iso) continue;
    map[s.iso] = (map[s.iso] || 0) + scheduledPaidMinutes(s, emp);
  }
  return map;
}

export function buildShiftsForEmployeeInWeek(
  emp: EmployeeRow,
  teamState: Record<string, unknown> | null,
  employees: EmployeeLite[],
  bounds: PayWeekBounds,
  cachedCtx?: ScheduleContext,
  options?: BuildShiftsOptions
): ShiftDayRow[] {
  const scheduleCtx =
    cachedCtx ?? buildScheduleContext(teamState, { bounds, employees });
  const todayIso = isoFromDate(new Date());
  const all = getWorkerScheduleShiftsForContext(emp, scheduleCtx, employees, bounds);
  const scheduled = all.map((s) => {
    const iso = s.iso ?? '';
    return {
      shift: s,
      iso,
      isToday: iso === todayIso,
      isUpcoming: iso > todayIso,
    };
  });

  const scheduledIsos = new Set(scheduled.map((r) => r.iso).filter(Boolean));
  const addedDayIsos = options?.addedDayIsos ?? getAddedOffScheduleDays(emp.id);
  const offIsos = collectOffScheduleDayIsos({
    empId: emp.id,
    bounds,
    scheduledIsos,
    entries: options?.entries,
    extrasSlice: options?.extrasSlice,
    dishwasherTipsSlice: options?.dishwasherTipsSlice,
    addedDayIsos,
    emp,
    staffRequests: options?.staffRequests,
  });
  const offSchedule = offIsos.map((iso) => makeOffScheduleShiftDayRow(iso));
  const activityParams = {
    empId: emp.id,
    entries: options?.entries,
    extrasSlice: options?.extrasSlice,
    dishwasherTipsSlice: options?.dishwasherTipsSlice,
    addedDayIsos,
    emp,
  };

  const rows = [...scheduled, ...offSchedule].filter((row) => {
    const hasActivity = dayHasTimecardActivity({ ...activityParams, iso: row.iso });
    if (isOffScheduleShiftDayRow(row)) return hasActivity;
    return scheduledPaidMinutes(row.shift, emp) > 0 || hasActivity;
  });

  // Safety net: punches or leave can feed weekly totals while the day was dropped from the list.
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const covered = new Set(rows.map((r) => r.iso).filter(Boolean));
  for (const e of options?.entries ?? []) {
    if (e.employee_id !== emp.id || !e.clock_in_at) continue;
    const punchIso = isoFromDate(new Date(e.clock_in_at));
    if (!punchIso || punchIso < weekStart || punchIso > weekEnd) continue;
    if (covered.has(punchIso)) continue;
    if (!entryHasMeaningfulPunch(e, punchIso)) continue;
    rows.push(makeOffScheduleShiftDayRow(punchIso));
    covered.add(punchIso);
  }
  const cur = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), bounds.start.getDate());
  const end = new Date(bounds.end.getFullYear(), bounds.end.getMonth(), bounds.end.getDate());
  while (cur <= end) {
    const dayIso = isoFromDate(cur);
    if (!covered.has(dayIso) && dayHasTimecardActivity({ ...activityParams, iso: dayIso })) {
      rows.push(makeOffScheduleShiftDayRow(dayIso));
      covered.add(dayIso);
    }
    cur.setDate(cur.getDate() + 1);
  }

  return rows.sort((a, b) => {
    if (a.iso !== b.iso) return String(a.iso).localeCompare(String(b.iso));
    if (isOffScheduleShiftDayRow(a) && !isOffScheduleShiftDayRow(b)) return 1;
    if (!isOffScheduleShiftDayRow(a) && isOffScheduleShiftDayRow(b)) return -1;
    return String(a.shift.start).localeCompare(String(b.shift.start));
  });
}

export function dailyRecordedMinutesForEmployee(
  entries: TimeClockEntry[],
  empId: string,
  shiftIso: string,
  emp?: EmployeeRow | null
): number {
  return findEntriesForDay(entries, empId, shiftIso).reduce(
    (sum, e) => sum + recordedPaidMinutes(e, null, emp),
    0
  );
}

export function dailyBreakMinutesForEmployee(
  entries: TimeClockEntry[],
  empId: string,
  shiftIso: string
): { minutes: number; onBreak: boolean } {
  const dayEntries = findEntriesForDay(entries, empId, shiftIso);
  let minutes = 0;
  let onBreak = false;
  for (const e of dayEntries) {
    minutes += effectiveBreakMinutes(e);
    if (isOnBreak(e)) onBreak = true;
  }
  return { minutes, onBreak };
}

export function formatDayBreakLabel(
  entries: TimeClockEntry[],
  empId: string,
  shiftIso: string
): string {
  const dayEntries = findEntriesForDay(entries, empId, shiftIso);
  if (!dayEntries.length) return '—';
  const { minutes, onBreak } = dailyBreakMinutesForEmployee(entries, empId, shiftIso);
  if (!minutes && !onBreak) return '—';
  let label = `${minutes} min`;
  if (onBreak) label += ' · on break';
  return label;
}

export function computeSpreadOfHours(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  options?: {
    locationFilter?: LocationFilter;
    scheduleCtx?: ScheduleContext;
    bounds?: PayWeekBounds;
  }
) {
  const locationFilter = options?.locationFilter ?? 'all';
  const scheduleCtx = options?.scheduleCtx;
  const bounds = options?.bounds;
  const weekStart = bounds ? isoFromDate(bounds.start) : null;
  const weekEnd = bounds ? isoFromDate(bounds.end) : null;
  const byDay: Record<string, number> = {};
  const spanByDay: Record<string, number> = {};
  const extendsPastByDay: Record<string, boolean> = {};
  for (const e of entries) {
    if (e.employee_id !== emp.id || !e.clock_in_at) continue;
    if (!e.clock_out_at) continue;
    if (
      locationFilter !== 'all' &&
      scheduleCtx &&
      entryRestaurantId(emp, e, entries, scheduleCtx) !== locationFilter
    ) {
      continue;
    }
    const iso = punchDayIso(e);
    if (!iso || (weekStart && weekEnd && (iso < weekStart || iso > weekEnd))) continue;
    byDay[iso] = (byDay[iso] || 0) + recordedPaidMinutesOnClockInDay(e, null, emp);
    spanByDay[iso] = (spanByDay[iso] || 0) + recordedSpanMinutesOnClockInDay(e);
    if (entryExtendsPaidWorkPastSohThreshold(e, null, emp)) extendsPastByDay[iso] = true;
  }
  const dates: string[] = [];
  let count = 0;
  let pay = 0;
  for (const iso of Object.keys(byDay).sort()) {
    const roundedDay = roundToNearest5Minutes(byDay[iso]);
    if (
      dayQualifiesForSpreadOfHours(roundedDay, spanByDay[iso] || 0, !!extendsPastByDay[iso])
    ) {
      count += 1;
      dates.push(iso);
      pay += SOH_PAY_HOURS * getSohRate();
    }
  }
  return { count, dates, pay, hasRate: true };
}

export function formatSoHDatesList(dates: string[]): string {
  if (!dates.length) return '—';
  return dates
    .map((iso) => {
      const dt = new Date(iso + 'T12:00:00');
      return Number.isNaN(dt.getTime())
        ? iso
        : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    })
    .join(', ');
}

function rosterGrandTotalPay(row: {
  regPay: number | null;
  otPay: number | null;
  vlPay: number;
  slPay: number;
  sohPay: number | null;
  dishwasherTipsPay?: number;
  additionalCashTip?: number;
  totalMins: number;
  otMins: number;
  vlHours: number;
  slHours: number;
  sohCount: number;
}): number | null {
  if (row.regPay == null && row.totalMins > 0) return null;
  if (row.otPay == null && row.otMins > 0) return null;
  if (row.vlPay == null && row.vlHours > 0) return null;
  if (row.slPay == null && row.slHours > 0) return null;
  if (row.sohPay == null && row.sohCount > 0) return null;
  return (
    (row.regPay || 0) +
    (row.otPay || 0) +
    row.vlPay +
    row.slPay +
    (row.sohPay || 0) +
    (row.dishwasherTipsPay || 0) +
    (row.additionalCashTip || 0)
  );
}

export function computeSpreadOfHoursIndexed(
  emp: EmployeeRow,
  empEntries: TimeClockEntry[],
  options?: {
    locationFilter?: LocationFilter;
    scheduleCtx?: ScheduleContext;
    allEntries?: TimeClockEntry[];
    bounds?: PayWeekBounds;
  }
) {
  const locationFilter = options?.locationFilter ?? 'all';
  const scheduleCtx = options?.scheduleCtx;
  const allEntries = options?.allEntries ?? empEntries;
  const bounds = options?.bounds;
  const weekStart = bounds ? isoFromDate(bounds.start) : null;
  const weekEnd = bounds ? isoFromDate(bounds.end) : null;
  const byDay: Record<string, number> = {};
  const spanByDay: Record<string, number> = {};
  const extendsPastByDay: Record<string, boolean> = {};
  for (const e of empEntries) {
    if (!e.clock_in_at || !e.clock_out_at) continue;
    if (
      locationFilter !== 'all' &&
      scheduleCtx &&
      entryRestaurantId(emp, e, allEntries, scheduleCtx) !== locationFilter
    ) {
      continue;
    }
    const iso = punchDayIso(e);
    if (!iso || (weekStart && weekEnd && (iso < weekStart || iso > weekEnd))) continue;
    byDay[iso] = (byDay[iso] || 0) + recordedPaidMinutesOnClockInDay(e, null, emp);
    spanByDay[iso] = (spanByDay[iso] || 0) + recordedSpanMinutesOnClockInDay(e);
    if (entryExtendsPaidWorkPastSohThreshold(e, null, emp)) extendsPastByDay[iso] = true;
  }
  const dates: string[] = [];
  let count = 0;
  let pay = 0;
  for (const iso of Object.keys(byDay).sort()) {
    const roundedDay = roundToNearest5Minutes(byDay[iso]);
    if (
      dayQualifiesForSpreadOfHours(roundedDay, spanByDay[iso] || 0, !!extendsPastByDay[iso])
    ) {
      count += 1;
      dates.push(iso);
      pay += SOH_PAY_HOURS * getSohRate();
    }
  }
  return { count, dates, pay, hasRate: true };
}

function shiftRestaurantId(shift: WorkerShiftRow): string {
  return shift?.restaurantId === 'rp-8' || shift?.restaurantId === 'rp-9' ? shift.restaurantId : 'rp-9';
}

export function shiftMatchesLocationFilter(
  shiftRow: ShiftDayRow,
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  locationFilter: LocationFilter,
  extrasSlice?: WeekExtrasSlice
): boolean {
  if (locationFilter === 'all') return true;
  if (!shiftRow?.shift) return true;
  if (isOffScheduleShiftDayRow(shiftRow)) {
    const dayEntries = entries.filter(
      (e) => e.employee_id === emp.id && punchDayIso(e) === shiftRow.iso
    );
    let sawMeaningful = false;
    for (const e of dayEntries) {
      if (!entryHasMeaningfulPunch(e, shiftRow.iso)) continue;
      sawMeaningful = true;
      if (entryRestaurantId(emp, e, entries, scheduleCtx) === locationFilter) return true;
    }
    if (sawMeaningful) return false;
    const leave = getEmployeeDayLeaveSync(emp.id, shiftRow.iso, extrasSlice ?? {});
    if (leave.vl > 0 || leave.sl > 0) return true;
    const fromBal = leaveHoursFromBalanceForDay(emp, shiftRow.iso);
    if (fromBal.vl > 0 || fromBal.sl > 0) return true;
    return punchDayRestaurantId(emp, shiftRow.iso, entries, scheduleCtx) === locationFilter;
  }
  return shiftRestaurantId(shiftRow.shift) === locationFilter;
}

export function buildRosterRowSync(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  scheduleCtx: ScheduleContext,
  staffRequests: StaffRequestUi[],
  employeesLite: EmployeeLite[],
  extrasSlice: WeekExtrasSlice,
  dishwasherTipsSlice: Record<string, number>,
  entriesIndex: Record<string, TimeClockEntry[]>,
  entriesByEmpId: Record<string, TimeClockEntry[]>,
  bounds: PayWeekBounds,
  locationFilter: LocationFilter = 'all'
): RosterRow {
  const name = employeeDisplayName(emp);
  const shifts = buildShiftsForEmployeeInWeek(emp, null, employeesLite, bounds, scheduleCtx, {
    entries,
    extrasSlice,
    dishwasherTipsSlice,
    staffRequests,
  });
  const schedMinsByDay = buildScheduledMinutesByDayForEmployee(
    emp,
    null,
    employeesLite,
    bounds,
    scheduleCtx
  );
  const extras = getEmployeeWeekExtrasSync(emp, name, bounds, staffRequests, schedMinsByDay, extrasSlice);

  let schedMins = 0;
  let needsReview = false;
  let open = false;
  const todayIso = isoFromDate(new Date());

  for (const row of shifts) {
    if (
      locationFilter !== 'all' &&
      !shiftMatchesLocationFilter(row, emp, entries, scheduleCtx, locationFilter, extrasSlice)
    ) {
      continue;
    }
    schedMins += scheduledPaidMinutes(row.shift, emp);
    const dayEntries = findEntriesForDayIndexed(entriesIndex, emp.id, row.iso);
    if (dayEntries.length) {
      const st = shiftStatusLabelForDay(row.shift, emp.id, row.iso, entries, emp);
      if (st === 'Review') needsReview = true;
      if (st === 'Open') open = true;
    } else if (row.iso <= todayIso) {
      needsReview = true;
    }
  }

  const dayRecorded = weekDayRecordedForEmployee(
    shifts,
    emp,
    entries,
    entriesIndex,
    scheduleCtx,
    locationFilter
  );
  const regOtByDay = weeklyRegOtByDay(dayRecorded);
  let regMins = 0;
  let otMins = 0;
  for (const day of dayRecorded) {
    const split = regOtByDay[day.iso];
    regMins += split.regMins;
    otMins += split.otMins;
  }

  const pay = payFromRegOtMinutes(emp, regMins, otMins);
  const soh = computeSpreadOfHoursIndexed(emp, entriesByEmpId[emp.id] || [], {
    locationFilter,
    scheduleCtx,
    allEntries: entries,
    bounds,
  });
  const vlPay = leavePayFromHours(emp, extras.vl);
  const slPay = leavePayFromHours(emp, extras.sl);
  const sohPay = soh.hasRate ? soh.pay : null;
  const dishwasherTipsPay = isDeliveryDishwasherStaff(emp)
    ? netTipAmount(
        sumEmployeeWeekDishwasherTipsSync(emp.id, bounds, dishwasherTipsSlice, {
          entries,
          extrasSlice,
          locationFilter,
        })
      )
    : 0;
  const additionalCashTip = sumEmployeeWeekAdditionalCashTipsSync(emp.id, bounds, extrasSlice);
  const status = open ? 'Open' : needsReview ? 'Review' : 'OK';
  const clockStatus = employeeClockStatus(emp, entries, scheduleCtx, locationFilter);
  const partial = {
    regPay: pay.regPay,
    otPay: pay.otPay,
    vlPay,
    slPay,
    sohPay,
    dishwasherTipsPay,
    additionalCashTip,
    totalMins: regMins + otMins,
    otMins,
    vlHours: extras.vl,
    slHours: extras.sl,
    sohCount: soh.count,
    sohDatesLabel: formatSoHDatesList(soh.dates),
  };

  return {
    empId: emp.id,
    name,
    role: staffTypeLabel(emp.staffType),
    deptRank: ROSTER_DEPT_RANK[emp.staffType] ?? 99,
    schedMins,
    regMins,
    otMins,
    regPay: pay.regPay,
    otPay: pay.otPay,
    grandTotalPay: rosterGrandTotalPay(partial),
    vlHours: extras.vl,
    slHours: extras.sl,
    sohCount: soh.count,
    sohDatesLabel: partial.sohDatesLabel,
    sohPay,
    vlPay,
    slPay,
    dishwasherTipsPay,
    additionalCashTip,
    status,
    statusRank: statusSortRank(status),
    clockStatus,
    clockStatusLabel: CLOCK_STATUS_LABELS[clockStatus],
    clockStatusRank: CLOCK_STATUS_RANK[clockStatus],
  };
}

export function computeRosterTotals(rows: RosterRow[]): RosterTotals {
  const t: RosterTotals = {
    headcount: rows.length,
    schedMins: 0,
    regMins: 0,
    otMins: 0,
    vlHours: 0,
    slHours: 0,
    sohCount: 0,
    regPay: 0,
    otPay: 0,
    vlPay: 0,
    slPay: 0,
    sohPay: 0,
    dishwasherTipsPay: 0,
    additionalCashTip: 0,
    grandTotalPay: 0,
    totalMins: 0,
    hasRegPay: false,
    hasOtPay: false,
    hasVlSlPay: false,
    hasSohPay: false,
    hasDishwasherTips: false,
    hasAdditionalCashTip: false,
    hasGrandTotal: false,
  };
  for (const r of rows) {
    t.schedMins += r.schedMins;
    t.regMins += r.regMins;
    t.otMins += r.otMins;
    t.vlHours += r.vlHours;
    t.slHours += r.slHours;
    t.sohCount += r.sohCount;
    t.totalMins += r.regMins + r.otMins;
    if (r.regPay != null) {
      t.regPay += r.regPay;
      t.hasRegPay = true;
    }
    if (r.otPay != null) {
      t.otPay += r.otPay;
      t.hasOtPay = true;
    }
    if (r.vlPay != null) {
      t.vlPay += r.vlPay;
      t.hasVlSlPay = true;
    }
    if (r.slPay != null) {
      t.slPay += r.slPay;
      t.hasVlSlPay = true;
    }
    if (r.sohPay != null) {
      t.sohPay += r.sohPay;
      t.hasSohPay = true;
    }
    if (r.dishwasherTipsPay > 0) {
      t.dishwasherTipsPay += r.dishwasherTipsPay;
      t.hasDishwasherTips = true;
    }
    if (r.additionalCashTip > 0) {
      t.additionalCashTip += r.additionalCashTip;
      t.hasAdditionalCashTip = true;
    }
    if (r.grandTotalPay != null) {
      t.grandTotalPay += r.grandTotalPay;
      t.hasGrandTotal = true;
    } else if (
      r.regPay != null ||
      r.otPay != null ||
      r.vlPay != null ||
      r.slPay != null ||
      r.sohPay != null ||
      r.dishwasherTipsPay > 0 ||
      r.additionalCashTip > 0
    ) {
      t.grandTotalPay +=
        (r.regPay ?? 0) +
        (r.otPay ?? 0) +
        (r.vlPay ?? 0) +
        (r.slPay ?? 0) +
        (r.sohPay ?? 0) +
        r.dishwasherTipsPay +
        r.additionalCashTip;
      t.hasGrandTotal = true;
    }
  }
  return t;
}

export function buildAllRosterRows(
  employees: EmployeeRow[],
  entries: TimeClockEntry[],
  teamState: Record<string, unknown> | null,
  staffRequests: StaffRequestUi[],
  employeesLite: EmployeeLite[],
  extrasSlice: WeekExtrasSlice,
  dishwasherTipsSlice: Record<string, number>,
  bounds: PayWeekBounds,
  locationFilter: LocationFilter = 'all'
): RosterRow[] {
  const scheduleCtx = buildScheduleContext(teamState, { bounds, employees: employeesLite });
  const entriesIndex = buildEntriesIndex(entries);
  const entriesByEmpId: Record<string, TimeClockEntry[]> = {};
  for (const e of entries) {
    if (!e.employee_id) continue;
    if (!entriesByEmpId[e.employee_id]) entriesByEmpId[e.employee_id] = [];
    entriesByEmpId[e.employee_id].push(e);
  }
  return employees.map((emp) =>
    buildRosterRowSync(
      emp,
      entries,
      scheduleCtx,
      staffRequests,
      employeesLite,
      extrasSlice,
      dishwasherTipsSlice,
      entriesIndex,
      entriesByEmpId,
      bounds,
      locationFilter
    )
  );
}

export async function buildRosterRow(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  teamState: Record<string, unknown> | null,
  staffRequests: StaffRequestUi[],
  employeesLite: EmployeeLite[],
  bounds: PayWeekBounds
): Promise<RosterRow> {
  const name = employeeDisplayName(emp);
  const scheduleCtx = buildScheduleContext(teamState, { bounds, employees: employeesLite });
  const extrasSlice = await loadWeekExtrasSlice(bounds);
  const tipsSlice = await loadDishwasherTipsSlice(bounds);
  const shifts = buildShiftsForEmployeeInWeek(emp, teamState, employeesLite, bounds, scheduleCtx, {
    entries,
    extrasSlice,
    dishwasherTipsSlice: tipsSlice,
  });
  const schedMinsByDay = buildScheduledMinutesByDayForEmployee(
    emp,
    teamState,
    employeesLite,
    bounds
  );
  const extras = await getEmployeeWeekExtras(emp, name, bounds, staffRequests, schedMinsByDay);

  let schedMins = 0;
  let needsReview = false;
  let open = false;

  for (const row of shifts) {
    schedMins += scheduledPaidMinutes(row.shift, emp);
    const dayEntries = findEntriesForDay(entries, emp.id, row.iso);
    if (dayEntries.length) {
      const st = shiftStatusLabelForDay(row.shift, emp.id, row.iso, entries, emp);
      if (st === 'Review') needsReview = true;
      if (st === 'Open') open = true;
    } else if (row.iso <= isoFromDate(new Date())) {
      needsReview = true;
    }
  }

  const dayRecorded = weekDayRecordedForEmployee(
    shifts,
    emp,
    entries,
    undefined,
    scheduleCtx,
    'all'
  );
  const regOtByDay = weeklyRegOtByDay(dayRecorded);
  let regMins = 0;
  let otMins = 0;
  for (const day of dayRecorded) {
    const split = regOtByDay[day.iso];
    regMins += split.regMins;
    otMins += split.otMins;
  }

  const pay = payFromRegOtMinutes(emp, regMins, otMins);
  const soh = computeSpreadOfHours(emp, entries, { bounds });
  const vlPay = leavePayFromHours(emp, extras.vl);
  const slPay = leavePayFromHours(emp, extras.sl);
  const sohPay = soh.hasRate ? soh.pay : null;
  const dishwasherTipsPay = isDeliveryDishwasherStaff(emp)
    ? netTipAmount(
        sumEmployeeWeekDishwasherTipsSync(emp.id, bounds, tipsSlice, {
          entries,
          extrasSlice,
        })
      )
    : 0;
  const additionalCashTip = sumEmployeeWeekAdditionalCashTipsSync(emp.id, bounds, extrasSlice);
  const status = open ? 'Open' : needsReview ? 'Review' : 'OK';
  const clockStatus = employeeClockStatus(emp, entries, scheduleCtx, 'all');
  const partial = {
    regPay: pay.regPay,
    otPay: pay.otPay,
    vlPay,
    slPay,
    sohPay,
    dishwasherTipsPay,
    additionalCashTip,
    totalMins: regMins + otMins,
    otMins,
    vlHours: extras.vl,
    slHours: extras.sl,
    sohCount: soh.count,
    sohDatesLabel: formatSoHDatesList(soh.dates),
  };

  return {
    empId: emp.id,
    name,
    role: staffTypeLabel(emp.staffType),
    deptRank: ROSTER_DEPT_RANK[emp.staffType] ?? 99,
    schedMins,
    regMins,
    otMins,
    regPay: pay.regPay,
    otPay: pay.otPay,
    grandTotalPay: rosterGrandTotalPay(partial),
    vlHours: extras.vl,
    slHours: extras.sl,
    sohCount: soh.count,
    sohDatesLabel: partial.sohDatesLabel,
    sohPay,
    vlPay,
    slPay,
    dishwasherTipsPay,
    additionalCashTip,
    status,
    statusRank: statusSortRank(status),
    clockStatus,
    clockStatusLabel: CLOCK_STATUS_LABELS[clockStatus],
    clockStatusRank: CLOCK_STATUS_RANK[clockStatus],
  };
}

export function formatHistoryLines(entry: TimeClockEntry): { when: string; lines: string[] }[] {
  let history: { at?: string; changes?: Record<string, { from?: unknown; to?: unknown }> }[] = [];
  if (Array.isArray(entry.edit_history)) history = entry.edit_history as typeof history;
  if (!history.length) return [];
  return history
    .slice()
    .reverse()
    .map((h) => {
      const when = h.at
        ? new Date(h.at).toLocaleString(undefined, {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
          })
        : '';
      const lines: string[] = [];
      if (h.changes) {
        for (const k of Object.keys(h.changes)) {
          const c = h.changes[k];
          const label =
            k === 'clock_in_at'
              ? 'Clock in'
              : k === 'clock_out_at'
                ? 'Clock out'
                : k === 'break_minutes'
                  ? 'Break'
                  : k === 'break_start_at'
                    ? 'Break start'
                    : k === 'break_end_at'
                      ? 'Break end'
                      : k;
          const fmtVal = (v: unknown) => {
            if (v == null || v === '') return '—';
            if (k === 'clock_in_at' || k === 'clock_out_at' || k === 'break_start_at' || k === 'break_end_at') {
              return formatPunchClock(String(v));
            }
            if (k === 'break_minutes') return `${Number(v)} min`;
            return String(v);
          };
          lines.push(`${label}: ${fmtVal(c.from)} → ${fmtVal(c.to)}`);
        }
      }
      return { when, lines };
    });
}

export {
  getEmployeeDayLeave,
  getEmployeeWeekExtras,
  getEffectiveDayLeaveSync,
  getSuggestedDayLeave,
  setEmployeeDayLeave,
  setEmployeeWeekExtras,
  loadWeekExtrasSlice,
} from './weekExtras';
export { formatPunchClock } from './punch';
export { normalizePunchTimesForShift } from './punch';
