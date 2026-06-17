import AsyncStorage from '@react-native-async-storage/async-storage';
import { entryHasMeaningfulPunch } from './offScheduleShift';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import { getEmployeeDayLeaveSync } from './weekExtras';
import type { PayWeekBounds, TimeClockEntry } from './types';

const TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';

export const DISHWASHER_TIP_REQUIRES_SHIFT_MSG =
  'Save a punch or vacation/sick hours before entering dishwasher tips.';

export function isDeliveryDishwasherStaff(emp: { staffType?: string } | null): boolean {
  return !!(emp && emp.staffType === 'Server');
}

export function dayDishwasherTipStorageKey(empId: string, iso: string): string {
  return `${empId}@${iso}`;
}

function dayHasBackingShiftForDishwasherTips(
  empId: string,
  iso: string,
  entries?: TimeClockEntry[],
  extrasSlice?: Record<string, { vl: number; sl: number; manual?: boolean }>
): boolean {
  if (!empId || !iso) return false;
  for (const e of entries ?? []) {
    if (e.employee_id !== empId || !e.clock_in_at) continue;
    const punchIso = isoFromDate(new Date(e.clock_in_at));
    if (punchIso === iso && entryHasMeaningfulPunch(e, iso)) return true;
  }
  const leave = getEmployeeDayLeaveSync(empId, iso, extrasSlice ?? {});
  if (leave.vl > 0 || leave.sl > 0) return true;
  return false;
}

function normalizeTipAmount(val: unknown): number {
  if (val == null || val === '') return 0;
  const n = parseFloat(String(val));
  if (Number.isNaN(n) || n < 0) return 0;
  return Math.round(n * 100) / 100;
}

async function loadTipsMap(bounds: PayWeekBounds): Promise<Record<string, number>> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw) as Record<string, unknown>;
    if (!all || typeof all !== 'object') return {};
    const slice = all[weekBoundsStorageKey(bounds)];
    if (!slice || typeof slice !== 'object') return {};
    const out: Record<string, number> = {};
    for (const k of Object.keys(slice as Record<string, unknown>)) {
      out[k] = normalizeTipAmount((slice as Record<string, unknown>)[k]);
    }
    return out;
  } catch {
    return {};
  }
}

export async function loadDishwasherTipsSlice(bounds: PayWeekBounds): Promise<Record<string, number>> {
  return loadTipsMap(bounds);
}

export function getEmployeeDayDishwasherTipSync(
  empId: string,
  iso: string,
  slice: Record<string, number>
): number {
  return normalizeTipAmount(slice[dayDishwasherTipStorageKey(empId, iso)]);
}

export async function getEmployeeDayDishwasherTip(
  empId: string,
  iso: string,
  bounds: PayWeekBounds
): Promise<number> {
  const slice = await loadTipsMap(bounds);
  return getEmployeeDayDishwasherTipSync(empId, iso, slice);
}

export async function setEmployeeDayDishwasherTip(
  empId: string,
  iso: string,
  amount: number,
  bounds: PayWeekBounds
): Promise<void> {
  const slice = await loadTipsMap(bounds);
  const key = dayDishwasherTipStorageKey(empId, iso);
  const val = normalizeTipAmount(amount);
  if (val <= 0) delete slice[key];
  else slice[key] = val;
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekBoundsStorageKey(bounds)]: slice };
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

export function sumEmployeeWeekDishwasherTipsSync(
  empId: string,
  bounds: PayWeekBounds,
  slice: Record<string, number>,
  options?: {
    entries?: TimeClockEntry[];
    extrasSlice?: Record<string, { vl: number; sl: number; manual?: boolean }>;
  }
): number {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  let sum = 0;
  for (const k of Object.keys(slice)) {
    const at = k.indexOf('@');
    if (at < 0) continue;
    if (k.slice(0, at) !== empId) continue;
    const iso = k.slice(at + 1);
    if (iso < weekStart || iso > weekEnd) continue;
    if (
      options &&
      !dayHasBackingShiftForDishwasherTips(empId, iso, options.entries, options.extrasSlice)
    ) {
      continue;
    }
    sum += normalizeTipAmount(slice[k]);
  }
  return Math.round(sum * 100) / 100;
}

export function sumWeekDishwasherTipsSync(bounds: PayWeekBounds, slice: Record<string, number>): number {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  let sum = 0;
  for (const k of Object.keys(slice)) {
    const at = k.indexOf('@');
    if (at < 0) continue;
    const iso = k.slice(at + 1);
    if (iso < weekStart || iso > weekEnd) continue;
    sum += normalizeTipAmount(slice[k]);
  }
  return Math.round(sum * 100) / 100;
}
