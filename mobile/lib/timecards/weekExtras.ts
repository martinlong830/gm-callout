import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmployeeRow } from '../employees';
import type { StaffRequestUi } from '../staffRequests';
import { isSupabaseConfigured, supabase } from '../supabase';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import { queueTipPayrollPushToSupabase } from './tipPayrollSync';
import type { PayWeekBounds } from './types';
import type { WeekExtras } from './types';

const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
const LEAVE_DEFAULT_DAY_MINUTES = 8 * 60;

/** Leave row or scalar extras (coverage compensation uses `acash|empId|iso` → number). */
export type DayLeaveRow = { vl: number; sl: number; manual?: boolean };
export type WeekExtrasSlice = Record<string, DayLeaveRow | number>;

function isDayLeaveRow(val: unknown): val is DayLeaveRow {
  return !!val && typeof val === 'object' && !Array.isArray(val);
}

function normalizeMoneyAmount(val: unknown): number {
  if (val == null || val === '') return 0;
  const n = parseFloat(String(val));
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

async function loadWeekExtrasMap(bounds: PayWeekBounds): Promise<WeekExtrasSlice> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, unknown>;
    if (!all || typeof all !== 'object') return {};
    const slice = all[weekBoundsStorageKey(bounds)];
    return slice && typeof slice === 'object' ? (slice as WeekExtrasSlice) : {};
  } catch {
    return {};
  }
}

let cachedWeekExtrasKey: string | null = null;
let cachedWeekExtrasSlice: WeekExtrasSlice | null = null;

export function invalidateWeekExtrasSliceCache(bounds?: PayWeekBounds): void {
  if (bounds && cachedWeekExtrasKey !== weekBoundsStorageKey(bounds)) return;
  cachedWeekExtrasKey = null;
  cachedWeekExtrasSlice = null;
}

export async function loadWeekExtrasSlice(bounds: PayWeekBounds) {
  const key = weekBoundsStorageKey(bounds);
  if (cachedWeekExtrasKey === key && cachedWeekExtrasSlice) return cachedWeekExtrasSlice;
  const slice = await loadWeekExtrasMap(bounds);
  cachedWeekExtrasKey = key;
  cachedWeekExtrasSlice = slice;
  return slice;
}

function leaveMinutesForIsoDay(schedMinsByDay: Record<string, number>, iso: string): number {
  const mins = schedMinsByDay[iso];
  if (mins != null && mins > 0) return mins;
  return LEAVE_DEFAULT_DAY_MINUTES;
}

function computeLeaveExtrasFromRequests(
  emp: EmployeeRow,
  displayName: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>
): WeekExtras {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  let vlMins = 0;
  let slMins = 0;
  for (const req of staffRequests) {
    if (req.status !== 'approved') continue;
    if (!staffRequestMatchesEmployee(req, emp, displayName)) continue;
    const range = parseTimeoffRequest(req);
    if (!range) continue;
    const overlapStart = range.start > weekStart ? range.start : weekStart;
    const overlapEnd = range.end < weekEnd ? range.end : weekEnd;
    if (overlapEnd < overlapStart) continue;
    let cur = new Date(overlapStart + 'T12:00:00');
    const endD = new Date(overlapEnd + 'T12:00:00');
    while (cur <= endD) {
      const iso = isoFromDate(cur);
      const dayMins = leaveMinutesForIsoDay(schedMinsByDay, iso);
      if (range.leaveType === 'sick') slMins += dayMins;
      else vlMins += dayMins;
      cur.setDate(cur.getDate() + 1);
    }
  }
  return { vl: vlMins / 60, sl: slMins / 60, manual: false };
}

type LeaveBalanceSide = { entries?: { date?: string; hours?: number }[] };
type LeaveBalance = {
  vacation?: LeaveBalanceSide;
  sick?: LeaveBalanceSide;
};

export function leaveHoursFromBalanceForDay(emp: EmployeeRow, iso: string): { vl: number; sl: number } {
  if (!iso) return { vl: 0, sl: 0 };
  const bal = emp.meta?.leaveBalance as LeaveBalance | undefined;
  if (!bal) return { vl: 0, sl: 0 };
  let vl = 0;
  let sl = 0;
  for (const e of bal.vacation?.entries ?? []) {
    if (String(e.date ?? '').slice(0, 10) === iso) {
      vl += Math.max(0, parseFloat(String(e.hours)) || 0);
    }
  }
  for (const e of bal.sick?.entries ?? []) {
    if (String(e.date ?? '').slice(0, 10) === iso) {
      sl += Math.max(0, parseFloat(String(e.hours)) || 0);
    }
  }
  return { vl, sl };
}

function leaveHoursFromRequestsForDay(
  emp: EmployeeRow,
  displayName: string,
  iso: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>
): { vl: number; sl: number } {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  if (!iso || iso < weekStart || iso > weekEnd) return { vl: 0, sl: 0 };
  let vlMins = 0;
  let slMins = 0;
  for (const req of staffRequests) {
    if (req.status !== 'approved') continue;
    if (!staffRequestMatchesEmployee(req, emp, displayName)) continue;
    const range = parseTimeoffRequest(req);
    if (!range) continue;
    if (iso < range.start || iso > range.end) continue;
    const dayMins = leaveMinutesForIsoDay(schedMinsByDay, iso);
    if (range.leaveType === 'sick') slMins += dayMins;
    else vlMins += dayMins;
  }
  return { vl: vlMins / 60, sl: slMins / 60 };
}

function computeLeaveHoursFromBalance(emp: EmployeeRow, bounds: PayWeekBounds): WeekExtras {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const bal = emp.meta?.leaveBalance as LeaveBalance | undefined;
  if (!bal) return { vl: 0, sl: 0, manual: false };
  let vl = 0;
  let sl = 0;
  for (const e of bal.vacation?.entries ?? []) {
    const d = String(e.date ?? '').slice(0, 10);
    if (d >= weekStart && d <= weekEnd) vl += Math.max(0, parseFloat(String(e.hours)) || 0);
  }
  for (const e of bal.sick?.entries ?? []) {
    const d = String(e.date ?? '').slice(0, 10);
    if (d >= weekStart && d <= weekEnd) sl += Math.max(0, parseFloat(String(e.hours)) || 0);
  }
  return { vl, sl, manual: false };
}

/**
 * Effective VL/SL for a day: per-day week-extras, else leaveBalance, else approved requests.
 * Week-level manual override suppresses auto sources for per-day display.
 */
export function getEffectiveDayLeaveSync(
  emp: EmployeeRow,
  displayName: string,
  iso: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>,
  slice: WeekExtrasSlice
): { vl: number; sl: number } {
  if (!iso) return { vl: 0, sl: 0 };
  const key = dayLeaveStorageKey(emp.id, iso);
  const row = slice[key];
  if (isDayLeaveRow(row) && row.manual !== false) {
    return {
      vl: Math.max(0, parseFloat(String(row.vl)) || 0),
      sl: Math.max(0, parseFloat(String(row.sl)) || 0),
    };
  }
  const weekRow = slice[emp.id];
  if (isDayLeaveRow(weekRow) && weekRow.manual) return { vl: 0, sl: 0 };
  const fromBal = leaveHoursFromBalanceForDay(emp, iso);
  if (fromBal.vl > 0 || fromBal.sl > 0) return fromBal;
  return leaveHoursFromRequestsForDay(emp, displayName, iso, bounds, staffRequests, schedMinsByDay);
}

/** Auto VL/SL for one calendar day (not yet saved to per-day storage). */
export function getSuggestedDayLeaveSync(
  emp: EmployeeRow,
  displayName: string,
  iso: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>,
  slice: WeekExtrasSlice
): { vl: number; sl: number } {
  if (!iso) return { vl: 0, sl: 0 };
  const key = dayLeaveStorageKey(emp.id, iso);
  if (isDayLeaveRow(slice[key]) && (slice[key] as DayLeaveRow).manual !== false) {
    return { vl: 0, sl: 0 };
  }
  const weekRow = slice[emp.id];
  if (isDayLeaveRow(weekRow) && weekRow.manual) return { vl: 0, sl: 0 };
  const fromBal = leaveHoursFromBalanceForDay(emp, iso);
  if (fromBal.vl > 0 || fromBal.sl > 0) return fromBal;
  return leaveHoursFromRequestsForDay(emp, displayName, iso, bounds, staffRequests, schedMinsByDay);
}

export async function getSuggestedDayLeave(
  emp: EmployeeRow,
  displayName: string,
  iso: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>
): Promise<{ vl: number; sl: number }> {
  const slice = await loadWeekExtrasMap(bounds);
  return getSuggestedDayLeaveSync(emp, displayName, iso, bounds, staffRequests, schedMinsByDay, slice);
}

export function dayLeaveStorageKey(empId: string, iso: string): string {
  return `${empId}@${iso}`;
}

export function getEmployeeDayLeaveSync(
  empId: string,
  iso: string,
  slice: WeekExtrasSlice
): { vl: number; sl: number } {
  const row = slice[dayLeaveStorageKey(empId, iso)];
  if (!isDayLeaveRow(row) || row.manual === false) return { vl: 0, sl: 0 };
  return {
    vl: Math.max(0, parseFloat(String(row.vl)) || 0),
    sl: Math.max(0, parseFloat(String(row.sl)) || 0),
  };
}

export async function getEmployeeDayLeave(
  empId: string,
  iso: string,
  bounds: PayWeekBounds
): Promise<{ vl: number; sl: number }> {
  const slice = await loadWeekExtrasMap(bounds);
  return getEmployeeDayLeaveSync(empId, iso, slice);
}

export async function setEmployeeDayLeave(
  empId: string,
  iso: string,
  vl: number,
  sl: number,
  bounds: PayWeekBounds
): Promise<void> {
  const slice = await loadWeekExtrasMap(bounds);
  const key = dayLeaveStorageKey(empId, iso);
  const v = Math.max(0, vl);
  const s = Math.max(0, sl);
  // Keep explicit zeros so leaveBalance / requests do not reappear after clear.
  slice[key] = { vl: v, sl: s, manual: true };
  delete slice[empId];
  await saveWeekExtrasMap(bounds, slice);
}

export async function clearEmployeeDayLeave(
  empId: string,
  iso: string,
  bounds: PayWeekBounds
): Promise<void> {
  const slice = await loadWeekExtrasMap(bounds);
  delete slice[dayLeaveStorageKey(empId, iso)];
  await saveWeekExtrasMap(bounds, slice);
}

function sumManualDayLeaveForEmployee(
  empId: string,
  bounds: PayWeekBounds,
  slice: WeekExtrasSlice
): WeekExtras | null {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  let vl = 0;
  let sl = 0;
  let any = false;
  for (const k of Object.keys(slice)) {
    const at = k.indexOf('@');
    if (at < 0) continue;
    if (k.slice(0, at) !== empId) continue;
    const iso = k.slice(at + 1);
    if (iso < weekStart || iso > weekEnd) continue;
    const row = slice[k];
    if (!isDayLeaveRow(row)) continue;
    vl += Math.max(0, parseFloat(String(row.vl)) || 0);
    sl += Math.max(0, parseFloat(String(row.sl)) || 0);
    any = true;
  }
  return any ? { vl, sl, manual: true } : null;
}

export function getEmployeeWeekExtrasSync(
  emp: EmployeeRow,
  displayName: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>,
  slice: WeekExtrasSlice
): WeekExtras {
  const row = slice[emp.id];
  if (isDayLeaveRow(row) && row.manual) {
    const manualVl = Math.max(0, parseFloat(String(row.vl)) || 0);
    const manualSl = Math.max(0, parseFloat(String(row.sl)) || 0);
    if (manualVl > 0 || manualSl > 0) {
      return { vl: manualVl, sl: manualSl, manual: true };
    }
  }
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  let vl = 0;
  let sl = 0;
  let anyManual = false;
  const cur = new Date(bounds.start.getFullYear(), bounds.start.getMonth(), bounds.start.getDate());
  const end = new Date(bounds.end.getFullYear(), bounds.end.getMonth(), bounds.end.getDate());
  while (cur <= end) {
    const iso = isoFromDate(cur);
    if (iso >= weekStart && iso <= weekEnd) {
      const day = getEffectiveDayLeaveSync(
        emp,
        displayName,
        iso,
        bounds,
        staffRequests,
        schedMinsByDay,
        slice
      );
      vl += day.vl;
      sl += day.sl;
      if (slice[dayLeaveStorageKey(emp.id, iso)]) anyManual = true;
    }
    cur.setDate(cur.getDate() + 1);
  }
  if (vl > 0 || sl > 0) return { vl, sl, manual: anyManual };
  return { vl: 0, sl: 0, manual: false };
}

export async function getEmployeeWeekExtras(
  emp: EmployeeRow,
  displayName: string,
  bounds: PayWeekBounds,
  staffRequests: StaffRequestUi[],
  schedMinsByDay: Record<string, number>
): Promise<WeekExtras> {
  const slice = await loadWeekExtrasMap(bounds);
  return getEmployeeWeekExtrasSync(emp, displayName, bounds, staffRequests, schedMinsByDay, slice);
}

async function saveWeekExtrasMap(bounds: PayWeekBounds, slice: WeekExtrasSlice) {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekBoundsStorageKey(bounds)]: slice };
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(next));
    cachedWeekExtrasKey = weekBoundsStorageKey(bounds);
    cachedWeekExtrasSlice = slice;
    if (isSupabaseConfigured && supabase) queueTipPayrollPushToSupabase(supabase);
  } catch {
    /* ignore */
  }
}

/**
 * Coverage compensation (per employee per day, all roles). Stored inside the synced week-extras
 * slice under a pipe-delimited key so VL/SL leave parsers (which key on "@" or a bare employee id)
 * ignore it entirely.
 */
export function additionalCashTipStorageKey(empId: string, iso: string): string {
  return `acash|${String(empId || '')}|${String(iso || '')}`;
}

export function getEmployeeDayAdditionalCashTipSync(
  empId: string,
  iso: string,
  slice: WeekExtrasSlice
): number {
  if (!empId || !iso) return 0;
  return normalizeMoneyAmount(slice[additionalCashTipStorageKey(empId, iso)]);
}

export async function getEmployeeDayAdditionalCashTip(
  empId: string,
  iso: string,
  bounds: PayWeekBounds
): Promise<number> {
  const slice = await loadWeekExtrasMap(bounds);
  return getEmployeeDayAdditionalCashTipSync(empId, iso, slice);
}

export async function setEmployeeDayAdditionalCashTip(
  empId: string,
  iso: string,
  amount: number,
  bounds: PayWeekBounds
): Promise<void> {
  if (!empId || !iso) return;
  const slice = await loadWeekExtrasMap(bounds);
  const key = additionalCashTipStorageKey(empId, iso);
  const val = normalizeMoneyAmount(amount);
  if (val <= 0) delete slice[key];
  else slice[key] = val;
  await saveWeekExtrasMap(bounds, slice);
}

export function sumEmployeeWeekAdditionalCashTipsSync(
  empId: string,
  bounds: PayWeekBounds,
  slice: WeekExtrasSlice,
  precomputed?: Record<string, number>
): number {
  if (precomputed && empId && precomputed[empId] != null) return precomputed[empId];
  if (!empId) return 0;
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const prefix = `acash|${empId}|`;
  let sum = 0;
  for (const k of Object.keys(slice)) {
    if (!k.startsWith(prefix)) continue;
    const iso = k.slice(prefix.length);
    if (iso < weekStart || iso > weekEnd) continue;
    sum += normalizeMoneyAmount(slice[k]);
  }
  return Math.round(sum * 100) / 100;
}

function normNameKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function staffRequestMatchesEmployee(
  req: { employeeName?: string },
  emp: EmployeeRow,
  displayName: string
): boolean {
  const a = normNameKey(displayName || '');
  const b = normNameKey(req.employeeName || '');
  if (!a || !b) return false;
  if (a === b) return true;
  const ta = a.split(/\s+/).filter(Boolean);
  const tb = b.split(/\s+/).filter(Boolean);
  if (!ta.length || !tb.length) return false;
  if (ta[0] !== tb[0]) return false;
  if (ta.length === 1 || tb.length === 1) return ta[0] === tb[0];
  const tl = ta[ta.length - 1].replace(/\.$/, '');
  const bl = tb[tb.length - 1].replace(/\.$/, '');
  return tl === bl || (tl.length > 0 && bl.length > 0 && tl[0] === bl[0]);
}

/** Parity with web `parseTimeoffRequest` — prefer explicit start/end, else summary range. */
export function parseTimeoffRequest(req: {
  type?: string;
  summary?: string;
  leaveType?: string;
  timeoffStart?: string;
  timeoffEnd?: string;
}): { start: string; end: string; leaveType: 'sick' | 'vacation' } | null {
  if (!req || req.type !== 'timeoff') return null;
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
  if (!start || !end || end < start) return null;
  let leaveType: 'sick' | 'vacation' =
    req.leaveType === 'sick' || req.leaveType === 'vacation' ? req.leaveType : 'vacation';
  if (req.leaveType !== 'sick' && req.leaveType !== 'vacation') {
    if (/^sick leave:/i.test(summary)) leaveType = 'sick';
    else if (/^vacation leave:/i.test(summary)) leaveType = 'vacation';
  }
  return { start, end, leaveType };
}

export async function setEmployeeWeekExtras(
  empId: string,
  vl: number,
  sl: number,
  bounds: PayWeekBounds
): Promise<void> {
  const slice = await loadWeekExtrasMap(bounds);
  for (const k of Object.keys(slice)) {
    const at = k.indexOf('@');
    if (at < 0) continue;
    if (k.slice(0, at) === empId) delete slice[k];
  }
  slice[empId] = { vl: Math.max(0, vl), sl: Math.max(0, sl), manual: true };
  await saveWeekExtrasMap(bounds, slice);
}
