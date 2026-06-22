import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { entryHasMeaningfulPunch } from './offScheduleShift';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import {
  queueTipPayrollPushToSupabase,
  TIMECARD_DISHWASHER_TIPS_KEY,
} from './tipPayrollSync';
import { getEmployeeDayLeaveSync } from './weekExtras';
import type { LocationFilter } from './restaurantAttribution';
import type { PayWeekBounds, TimeClockEntry } from './types';

const RP2_DELIVERY_TIP_LOCATION = 'rp-8';

export const DISHWASHER_TIP_REQUIRES_SHIFT_MSG =
  'Save a punch or vacation/sick hours before entering dishwasher tips.';

export function isDeliveryDishwasherStaff(emp: { staffType?: string } | null): boolean {
  return !!(emp && emp.staffType === 'Server');
}

export function dayDishwasherTipStorageKey(
  empId: string,
  iso: string,
  restaurantId?: string
): string {
  const rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
  return `${rid}|${empId}|${iso}`;
}

function parseDishwasherTipStorageKey(key: string): {
  restaurantId: string;
  empId: string;
  iso: string;
} | null {
  if (!key) return null;
  const pipe = key.indexOf('|');
  if (pipe >= 0) {
    const parts = key.split('|');
    if (parts.length >= 3) {
      return { restaurantId: parts[0], empId: parts[1], iso: parts.slice(2).join('|') };
    }
  }
  const at = key.indexOf('@');
  if (at < 0) return null;
  return { restaurantId: 'rp-9', empId: key.slice(0, at), iso: key.slice(at + 1) };
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

let cachedDishwasherTipsKey: string | null = null;
let cachedDishwasherTipsSlice: Record<string, number> | null = null;

export function invalidateDishwasherTipsSliceCache(bounds?: PayWeekBounds): void {
  if (bounds && cachedDishwasherTipsKey !== weekBoundsStorageKey(bounds)) return;
  cachedDishwasherTipsKey = null;
  cachedDishwasherTipsSlice = null;
}

export async function loadDishwasherTipsSlice(bounds: PayWeekBounds): Promise<Record<string, number>> {
  const key = weekBoundsStorageKey(bounds);
  if (cachedDishwasherTipsKey === key && cachedDishwasherTipsSlice) return cachedDishwasherTipsSlice;
  const slice = await loadTipsMap(bounds);
  cachedDishwasherTipsKey = key;
  cachedDishwasherTipsSlice = slice;
  return slice;
}

export function getEmployeeDayDishwasherTipSync(
  empId: string,
  iso: string,
  slice: Record<string, number>,
  restaurantId?: string
): number {
  const rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
  const keyed = slice[dayDishwasherTipStorageKey(empId, iso, rid)];
  if (keyed != null) return normalizeTipAmount(keyed);
  if (rid === 'rp-9') {
    const legacy = slice[`${empId}@${iso}`];
    if (legacy != null) return normalizeTipAmount(legacy);
  }
  return 0;
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
  bounds: PayWeekBounds,
  restaurantId?: string
): Promise<void> {
  const slice = await loadTipsMap(bounds);
  const rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
  const key = dayDishwasherTipStorageKey(empId, iso, rid);
  const val = normalizeTipAmount(amount);
  if (val <= 0) delete slice[key];
  else slice[key] = val;
  if (rid === 'rp-9') delete slice[`${empId}@${iso}`];
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekBoundsStorageKey(bounds)]: slice };
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(next));
    cachedDishwasherTipsKey = weekBoundsStorageKey(bounds);
    cachedDishwasherTipsSlice = slice;
    if (isSupabaseConfigured && supabase) {
      queueTipPayrollPushToSupabase(supabase);
    }
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
    locationFilter?: LocationFilter;
  }
): number {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const locationFilter = options?.locationFilter ?? 'all';
  let sum = 0;
  for (const k of Object.keys(slice)) {
    const parsed = parseDishwasherTipStorageKey(k);
    if (!parsed || parsed.empId !== empId) continue;
    if (parsed.iso < weekStart || parsed.iso > weekEnd) continue;
    if (locationFilter !== 'all' && parsed.restaurantId !== locationFilter) continue;
    if (
      options &&
      !dayHasBackingShiftForDishwasherTips(empId, parsed.iso, options.entries, options.extrasSlice)
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
    const parsed = parseDishwasherTipStorageKey(k);
    if (!parsed) continue;
    if (parsed.iso < weekStart || parsed.iso > weekEnd) continue;
    sum += normalizeTipAmount(slice[k]);
  }
  return Math.round(sum * 100) / 100;
}
