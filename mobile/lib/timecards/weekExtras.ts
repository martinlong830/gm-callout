import AsyncStorage from '@react-native-async-storage/async-storage';
import type { EmployeeRow } from '../employees';
import type { StaffRequestUi } from '../staffRequests';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import type { PayWeekBounds } from './types';
import type { WeekExtras } from './types';

const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';
const LEAVE_DEFAULT_DAY_MINUTES = 8 * 60;

async function loadWeekExtrasMap(bounds: PayWeekBounds): Promise<Record<string, { vl: number; sl: number; manual?: boolean }>> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, unknown>;
    if (!all || typeof all !== 'object') return {};
    const slice = all[weekBoundsStorageKey(bounds)];
    return slice && typeof slice === 'object' ? (slice as Record<string, { vl: number; sl: number; manual?: boolean }>) : {};
  } catch {
    return {};
  }
}

export async function loadWeekExtrasSlice(bounds: PayWeekBounds) {
  return loadWeekExtrasMap(bounds);
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
      const dayMins = schedMinsByDay[iso] > 0 ? schedMinsByDay[iso] : LEAVE_DEFAULT_DAY_MINUTES;
      if (range.leaveType === 'sick') slMins += dayMins;
      else vlMins += dayMins;
      cur.setDate(cur.getDate() + 1);
    }
  }
  return { vl: vlMins / 60, sl: slMins / 60, manual: false };
}

export function dayLeaveStorageKey(empId: string, iso: string): string {
  return `${empId}@${iso}`;
}

export function getEmployeeDayLeaveSync(
  empId: string,
  iso: string,
  slice: Record<string, { vl: number; sl: number; manual?: boolean }>
): { vl: number; sl: number } {
  const row = slice[dayLeaveStorageKey(empId, iso)];
  if (!row) return { vl: 0, sl: 0 };
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
  if (v <= 0 && s <= 0) delete slice[key];
  else slice[key] = { vl: v, sl: s, manual: true };
  delete slice[empId];
  await saveWeekExtrasMap(bounds, slice);
}

function sumManualDayLeaveForEmployee(
  empId: string,
  bounds: PayWeekBounds,
  slice: Record<string, { vl: number; sl: number; manual?: boolean }>
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
    if (!row) continue;
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
  slice: Record<string, { vl: number; sl: number; manual?: boolean }>
): WeekExtras {
  const daySum = sumManualDayLeaveForEmployee(emp.id, bounds, slice);
  if (daySum) return daySum;
  const row = slice[emp.id];
  if (row?.manual) {
    return {
      vl: Math.max(0, parseFloat(String(row.vl)) || 0),
      sl: Math.max(0, parseFloat(String(row.sl)) || 0),
      manual: true,
    };
  }
  return computeLeaveExtrasFromRequests(emp, displayName, bounds, staffRequests, schedMinsByDay);
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

async function saveWeekExtrasMap(bounds: PayWeekBounds, slice: Record<string, { vl: number; sl: number; manual?: boolean }>) {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekBoundsStorageKey(bounds)]: slice };
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

function normNameKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function staffRequestMatchesEmployee(req: StaffRequestUi, emp: EmployeeRow, displayName: string): boolean {
  const a = normNameKey(displayName);
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

function parseTimeoffRequest(req: StaffRequestUi): { start: string; end: string; leaveType: 'sick' | 'vacation' } | null {
  if (req.type !== 'timeoff') return null;
  const summary = String(req.summary || '');
  const m = summary.match(
    /(?:Time Off|Vacation leave|Sick leave):\s*(\d{4}-\d{2}-\d{2})\s+to\s+(\d{4}-\d{2}-\d{2})/i
  );
  let start = m ? m[1] : '';
  let end = m ? m[2] : '';
  if (!start || !end || end < start) return null;
  let leaveType: 'sick' | 'vacation' = 'vacation';
  if (/^sick leave:/i.test(summary)) leaveType = 'sick';
  else if (/^vacation leave:/i.test(summary)) leaveType = 'vacation';
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
