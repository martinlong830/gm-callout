import type { EmployeeRow } from '../employees';
import { employeeDisplayName, staffTypeLabel } from '../employees';
import type { StaffRequestUi } from '../staffRequests';
import {
  buildAllLocationsWorkerShiftRows,
  buildWeeksFromMonday,
  defaultRestaurants,
  getThisMondayDate,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  assignmentShell,
  redPokeShiftHoursDecimal,
  redPokeShiftTimeLabel,
  SCHEDULE_VIEW_WEEK_COUNT,
  type WorkerShiftRow,
} from '../schedule/engine';
import type { EmployeeLite, WeekMeta } from '../schedule/types';
import { isoFromDate, getPayWeekBounds } from './payWeek';
import {
  punchShiftRoundedMinutes,
  scheduledShiftStartAt,
  formatPunchClock,
} from './punch';
import type { PayWeekBounds, RosterRow, ShiftDayRow, TimeClockEntry, WeekExtras } from './types';

import { getEmployeeWeekExtras } from './weekExtras';

export type { RosterRow, ShiftDayRow, WeekExtras, TimeClockEntry, PayWeekBounds };

const OT_RATE_MULTIPLIER = 1.5;
const PAY_ROUND_MINUTES = 15;
const SOH_THRESHOLD_MINUTES = 10 * 60;
const SOH_PAY_HOURS = 1;
const SOH_DEFAULT_HOURLY_RATE = 15;

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

export function scheduledPaidMinutes(shift: WorkerShiftRow): number {
  const hrs = parseScheduledHoursDecimal(shift);
  const br = parseBreakMinutesFromAnnotation(shift.redPokeBreak);
  return Math.max(0, Math.round(hrs * 60) - br);
}

export function roundToNearest5Minutes(mins: number): number {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return Math.round(m / 5) * 5;
}

function roundToNearest15Minutes(mins: number): number {
  const m = Math.max(0, Math.round(Number(mins) || 0));
  return Math.round(m / PAY_ROUND_MINUTES) * PAY_ROUND_MINUTES;
}

export function shiftRegularOvertimeMinutes(schedMins: number, recordedMins: number) {
  const sched = roundToNearest15Minutes(schedMins);
  const rec = roundToNearest15Minutes(recordedMins);
  const regMins = Math.min(rec, sched);
  const otMins = Math.max(0, rec - sched);
  return { regMins, otMins, totalMins: regMins + otMins };
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

export function shiftPayForScheduledRecorded(emp: EmployeeRow, schedMins: number, recordedMins: number) {
  const split = shiftRegularOvertimeMinutes(schedMins, recordedMins);
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

export function effectiveBreakMinutes(entry: TimeClockEntry): number {
  if (entry.break_start_at) {
    const startTs = new Date(entry.break_start_at).getTime();
    if (!Number.isNaN(startTs)) {
      let endTs: number;
      if (entry.break_end_at) {
        endTs = new Date(entry.break_end_at).getTime();
      } else if (entry.clock_out_at) {
        endTs = new Date(entry.clock_out_at).getTime();
      } else {
        endTs = Date.now();
      }
      if (!Number.isNaN(endTs) && endTs > startTs) {
        return Math.max(0, Math.floor((endTs - startTs) / 60000));
      }
    }
  }
  const br = entry.break_minutes != null ? Number(entry.break_minutes) : 0;
  return Number.isNaN(br) ? 0 : br;
}

export function formatBreakRangeLabel(entry: TimeClockEntry): string {
  if (!entry.break_start_at) return '';
  const start = formatPunchClock(entry.break_start_at);
  if (entry.break_end_at) return `\nBreak ${start} – ${formatPunchClock(entry.break_end_at)}`;
  if (isOnBreak(entry)) return `\nBreak ${start} – on break`;
  return `\nBreak ${start} – —`;
}

export function recordedPaidMinutes(
  entry: TimeClockEntry,
  shiftRow?: ShiftDayRow | null
): number {
  const shiftStart = shiftRow ? scheduledShiftStartAt(shiftRow.iso, shiftRow.shift.start) : null;
  const gross = punchShiftRoundedMinutes(entry.clock_in_at, entry.clock_out_at, shiftStart);
  const br = effectiveBreakMinutes(entry);
  return Math.max(0, gross - br);
}

export function findEntriesForDay(entries: TimeClockEntry[], empId: string, shiftIso: string): TimeClockEntry[] {
  return entries.filter(
    (e) => e.employee_id === empId && e.clock_in_at && punchDayIso(e) === shiftIso
  );
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
  entries: TimeClockEntry[]
): string {
  const dayEntries = findEntriesForDay(entries, empId, shiftIso);
  if (!dayEntries.length) return 'No punch';
  if (dayEntries.some(isEntryOpen)) return 'Open';
  const sched = scheduledPaidMinutes(shift);
  const rec = dayEntries.reduce((sum, e) => sum + recordedPaidMinutes(e), 0);
  if (Math.abs(sched - rec) <= 15) return 'OK';
  return 'Review';
}

export function statusColor(status: string): { bg: string; text: string } {
  if (status === 'OK') return { bg: '#dcfce7', text: '#166534' };
  if (status === 'Open') return { bg: '#dbeafe', text: '#1e40af' };
  if (status === 'Review') return { bg: '#fef3c7', text: '#92400e' };
  return { bg: '#f1f5f9', text: '#64748b' };
}

export function buildScheduleContext(teamState: Record<string, unknown> | null) {
  const weekMeta = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getThisMondayDate());
  const allWeekDays = weekMeta.map((m) => m.label);
  const draftRows = loadDraftFromTeamState(teamState?.draft_schedule);
  const restaurants = defaultRestaurants();
  const assignmentStore = mergeRemoteAssignments(
    assignmentShell(restaurants),
    teamState?.schedule_assignments as Parameters<typeof mergeRemoteAssignments>[1],
    restaurants.map((r) => r.id)
  );
  return { weekMeta, allWeekDays, draftRows, restaurants, assignmentStore };
}

export function buildShiftsForEmployeeInWeek(
  emp: EmployeeRow,
  teamState: Record<string, unknown> | null,
  employees: EmployeeLite[]
): ShiftDayRow[] {
  const name = employeeDisplayName(emp);
  const bounds = getPayWeekBounds();
  const startIso = isoFromDate(bounds.start);
  const endIso = isoFromDate(bounds.end);
  const { weekMeta, allWeekDays, draftRows, restaurants, assignmentStore } = buildScheduleContext(teamState);
  const todayIso = isoFromDate(new Date());
  const labelToMeta = new Map(weekMeta.map((m) => [m.label, m]));
  const all = buildAllLocationsWorkerShiftRows(weekMeta, {
    allWeekDays,
    draftRows,
    employees,
    restaurants,
    assignmentStore,
    workerName: name,
  });
  return all
    .filter((s) => {
      const meta = labelToMeta.get(s.day);
      if (!meta?.iso) return false;
      return meta.iso >= startIso && meta.iso <= endIso;
    })
    .map((s) => {
      const meta = labelToMeta.get(s.day);
      const iso = meta?.iso ?? '';
      return {
        shift: s,
        iso,
        isToday: iso === todayIso,
        isUpcoming: iso > todayIso,
      };
    });
}

export function dailyRecordedMinutesForEmployee(
  entries: TimeClockEntry[],
  empId: string,
  shiftIso: string
): number {
  return findEntriesForDay(entries, empId, shiftIso).reduce((sum, e) => sum + recordedPaidMinutes(e), 0);
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

export function computeSpreadOfHours(emp: EmployeeRow, entries: TimeClockEntry[]) {
  const byDay: Record<string, number> = {};
  for (const e of entries) {
    if (e.employee_id !== emp.id || !e.clock_in_at) continue;
    const iso = punchDayIso(e);
    byDay[iso] = (byDay[iso] || 0) + recordedPaidMinutes(e);
  }
  const dates: string[] = [];
  let count = 0;
  let pay = 0;
  const rate = employeeHourlyRate(emp) ?? SOH_DEFAULT_HOURLY_RATE;
  for (const iso of Object.keys(byDay).sort()) {
    const roundedDay = roundToNearest5Minutes(byDay[iso]);
    if (roundedDay > SOH_THRESHOLD_MINUTES) {
      count += 1;
      dates.push(iso);
      pay += SOH_PAY_HOURS * rate;
    }
  }
  return { count, dates, pay, hasRate: employeeHourlyRate(emp) != null };
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
  return (row.regPay || 0) + (row.otPay || 0) + row.vlPay + row.slPay + (row.sohPay || 0);
}

export async function buildRosterRow(
  emp: EmployeeRow,
  entries: TimeClockEntry[],
  teamState: Record<string, unknown> | null,
  staffRequests: StaffRequestUi[],
  employeesLite: EmployeeLite[]
): Promise<RosterRow> {
  const name = employeeDisplayName(emp);
  const shifts = buildShiftsForEmployeeInWeek(emp, teamState, employeesLite);
  const schedMinsByDay: Record<string, number> = {};
  for (const row of shifts) {
    if (!row.iso) continue;
    schedMinsByDay[row.iso] = (schedMinsByDay[row.iso] || 0) + scheduledPaidMinutes(row.shift);
  }
  const extras = await getEmployeeWeekExtras(emp, name, getPayWeekBounds(), staffRequests, schedMinsByDay);

  let schedMins = 0;
  let regMins = 0;
  let otMins = 0;
  let needsReview = false;
  let open = false;

  for (const row of shifts) {
    const sched = scheduledPaidMinutes(row.shift);
    schedMins += sched;
    const dayEntries = findEntriesForDay(entries, emp.id, row.iso);
    if (dayEntries.length) {
      const rec = dailyRecordedMinutesForEmployee(entries, emp.id, row.iso);
      const split = shiftRegularOvertimeMinutes(sched, rec);
      regMins += split.regMins;
      otMins += split.otMins;
      const st = shiftStatusLabelForDay(row.shift, emp.id, row.iso, entries);
      if (st === 'Review') needsReview = true;
      if (st === 'Open') open = true;
    } else if (row.iso <= isoFromDate(new Date())) {
      needsReview = true;
    }
  }

  const pay = payFromRegOtMinutes(emp, regMins, otMins);
  const soh = computeSpreadOfHours(emp, entries);
  const vlPay = leavePayFromHours(emp, extras.vl);
  const slPay = leavePayFromHours(emp, extras.sl);
  const sohPay = soh.hasRate ? soh.pay : null;
  const status = open ? 'Open' : needsReview ? 'Review' : 'OK';
  const partial = {
    regPay: pay.regPay,
    otPay: pay.otPay,
    vlPay,
    slPay,
    sohPay,
    totalMins: regMins + otMins,
    otMins,
    vlHours: extras.vl,
    slHours: extras.sl,
    sohCount: soh.count,
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
    sohPay,
    status,
    statusRank: statusSortRank(status),
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

export { getEmployeeWeekExtras, setEmployeeWeekExtras } from './weekExtras';
export { formatPunchClock } from './punch';
export { normalizePunchTimesForShift } from './punch';
