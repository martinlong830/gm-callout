import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import {
  queueTipPayrollPushToSupabase,
  markTimecardDishwasherTipPendingAck,
  TIMECARD_DISHWASHER_TIPS_KEY,
} from './tipPayrollSync';
import type { WeekExtrasSlice } from './weekExtras';
import type { LocationFilter } from './restaurantAttribution';
import { netTipAmount, tipTakehomePctForRestaurant } from './tipTakehome';
import type { PayWeekBounds, TimeClockEntry } from './types';
import {
  tipTakehomePctForDishwasherEmployee,
  type EmployeeRow,
} from '../employees';

export { netTipAmount, grossFromNetTip, tipTakehomePctForRestaurant, tipTakehomeFactor } from './tipTakehome';
export { tipTakehomePctForDishwasherEmployee };

const RP2_DELIVERY_TIP_LOCATION = 'rp-8';
export function dishwasherTipRestaurantForShiftRow(
  shiftRow: { shift?: { restaurantId?: string }; iso?: string } | null | undefined,
  punchDayRestaurantId?: string | null
): string {
  if (!shiftRow?.shift) return punchDayRestaurantId || RP2_DELIVERY_TIP_LOCATION;
  const sid = shiftRow.shift.restaurantId;
  if (sid === 'rp-8' || sid === 'rp-9') return sid;
  // Off-schedule / missing restaurant: prefer day attribution, else delivery default.
  if (punchDayRestaurantId === 'rp-8' || punchDayRestaurantId === 'rp-9') {
    return punchDayRestaurantId;
  }
  return RP2_DELIVERY_TIP_LOCATION;
}

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
  // When restaurant is omitted (person-week list), sum every store key for that day so tips
  // saved under rp-9 / rp-8 (or legacy emp@iso) still show.
  if (restaurantId == null || restaurantId === '') {
    let sumAny = 0;
    for (const k of Object.keys(slice)) {
      const parsed = parseDishwasherTipStorageKey(k);
      if (!parsed || parsed.empId !== empId || parsed.iso !== iso) continue;
      sumAny += normalizeTipAmount(slice[k]);
    }
    return Math.round(sumAny * 100) / 100;
  }
  const rid = restaurantId || RP2_DELIVERY_TIP_LOCATION;
  const keyed = slice[dayDishwasherTipStorageKey(empId, iso, rid)];
  if (keyed != null) return normalizeTipAmount(keyed);
  if (rid === 'rp-9') {
    const legacy = slice[`${empId}@${iso}`];
    if (legacy != null) return normalizeTipAmount(legacy);
  }
  let only = 0;
  let onlyCount = 0;
  for (const k of Object.keys(slice)) {
    const parsed = parseDishwasherTipStorageKey(k);
    if (!parsed || parsed.empId !== empId || parsed.iso !== iso) continue;
    const amt = normalizeTipAmount(slice[k]);
    if (amt <= 0) continue;
    onlyCount += 1;
    only = amt;
  }
  return onlyCount === 1 ? only : 0;
}

/** Apply take-home % once per restaurant on summed gross (avoids penny drift from daily nets). */
function netFromGrossByRestaurant(
  grossByRestaurant: Record<string, number>,
  emp?: EmployeeRow | null
): number {
  let sumNet = 0;
  for (const rid of Object.keys(grossByRestaurant)) {
    const pct = tipTakehomePctForDishwasherEmployee(emp, rid, tipTakehomePctForRestaurant(rid));
    sumNet += netTipAmount(Math.round(grossByRestaurant[rid] * 100) / 100, rid, pct);
  }
  return Math.round(sumNet * 100) / 100;
}

/** Net tip pay for a day — applies each store’s tip take-home % when restaurant is omitted. */
export function getEmployeeDayDishwasherTipNetSync(
  empId: string,
  iso: string,
  slice: Record<string, number>,
  restaurantId?: string,
  emp?: EmployeeRow | null
): number {
  if (restaurantId == null || restaurantId === '') {
    const grossByRestaurant: Record<string, number> = {};
    for (const k of Object.keys(slice)) {
      const parsed = parseDishwasherTipStorageKey(k);
      if (!parsed || parsed.empId !== empId || parsed.iso !== iso) continue;
      grossByRestaurant[parsed.restaurantId] =
        (grossByRestaurant[parsed.restaurantId] || 0) + normalizeTipAmount(slice[k]);
    }
    return netFromGrossByRestaurant(grossByRestaurant, emp);
  }
  const pct = tipTakehomePctForDishwasherEmployee(
    emp,
    restaurantId,
    tipTakehomePctForRestaurant(restaurantId)
  );
  return netTipAmount(
    getEmployeeDayDishwasherTipSync(empId, iso, slice, restaurantId),
    restaurantId,
    pct
  );
}

export async function getEmployeeDayDishwasherTip(
  empId: string,
  iso: string,
  bounds: PayWeekBounds,
  restaurantId?: string
): Promise<number> {
  const slice = await loadTipsMap(bounds);
  return getEmployeeDayDishwasherTipSync(empId, iso, slice, restaurantId);
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
  const priorAmt = normalizeTipAmount(slice[key]);
  const others = Object.keys(slice).filter((k) => {
    if (k === key) return false;
    const parsed = parseDishwasherTipStorageKey(k);
    return !!(parsed && parsed.empId === empId && parsed.iso === iso);
  });
  const touched = [key];
  let siblingKeys = others;
  if (rid === 'rp-9') {
    const legacyKey = `${empId}@${iso}`;
    if (Object.prototype.hasOwnProperty.call(slice, legacyKey)) {
      delete slice[legacyKey];
      touched.push(legacyKey);
      siblingKeys = others.filter((k) => k !== legacyKey);
    }
  }
  if (val > 0) {
    slice[key] = val;
    if (priorAmt <= 0 && siblingKeys.length === 1) {
      delete slice[siblingKeys[0]];
      touched.push(siblingKeys[0]);
    }
  } else {
    delete slice[key];
    if (siblingKeys.length === 1) {
      delete slice[siblingKeys[0]];
      touched.push(siblingKeys[0]);
    }
  }
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekBoundsStorageKey(bounds)]: slice };
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(next));
    cachedDishwasherTipsKey = weekBoundsStorageKey(bounds);
    cachedDishwasherTipsSlice = slice;
    const weekKey = weekBoundsStorageKey(bounds);
    touched.forEach((k) => markTimecardDishwasherTipPendingAck(weekKey, k));
    if (isSupabaseConfigured && supabase) {
      queueTipPayrollPushToSupabase(supabase);
    }
  } catch {
    /* ignore */
  }
}

/**
 * Week tip pay (net). Sums gross per restaurant, then applies that store’s tip
 * take-home % once (so “All” mixes 9th/8th rates without daily-net penny drift).
 */
export function sumEmployeeWeekDishwasherTipsSync(
  empId: string,
  bounds: PayWeekBounds,
  slice: Record<string, number>,
  options?: {
    entries?: TimeClockEntry[];
    extrasSlice?: WeekExtrasSlice;
    locationFilter?: LocationFilter;
    /** When false, return gross tip dollars. Default true (pay totals). */
    asNet?: boolean;
    emp?: EmployeeRow | null;
  }
): number {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const locationFilter = options?.locationFilter ?? 'all';
  const asNet = options?.asNet !== false;
  let sumGross = 0;
  const grossByRestaurant: Record<string, number> = {};
  for (const k of Object.keys(slice)) {
    const parsed = parseDishwasherTipStorageKey(k);
    if (!parsed || parsed.empId !== empId) continue;
    if (parsed.iso < weekStart || parsed.iso > weekEnd) continue;
    if (locationFilter !== 'all' && parsed.restaurantId !== locationFilter) continue;
    const gross = normalizeTipAmount(slice[k]);
    if (asNet) {
      grossByRestaurant[parsed.restaurantId] =
        (grossByRestaurant[parsed.restaurantId] || 0) + gross;
    } else {
      sumGross += gross;
    }
  }
  if (!asNet) return Math.round(sumGross * 100) / 100;
  return netFromGrossByRestaurant(grossByRestaurant, options?.emp);
}

export function sumWeekDishwasherTipsSync(
  bounds: PayWeekBounds,
  slice: Record<string, number>,
  employeesById?: Record<string, EmployeeRow | null | undefined>
): number {
  const weekStart = isoFromDate(bounds.start);
  const weekEnd = isoFromDate(bounds.end);
  const grossByEmpRid: Record<string, Record<string, number>> = {};
  for (const k of Object.keys(slice)) {
    const parsed = parseDishwasherTipStorageKey(k);
    if (!parsed) continue;
    if (parsed.iso < weekStart || parsed.iso > weekEnd) continue;
    if (!grossByEmpRid[parsed.empId]) grossByEmpRid[parsed.empId] = {};
    grossByEmpRid[parsed.empId][parsed.restaurantId] =
      (grossByEmpRid[parsed.empId][parsed.restaurantId] || 0) + normalizeTipAmount(slice[k]);
  }
  let sum = 0;
  for (const empId of Object.keys(grossByEmpRid)) {
    sum += netFromGrossByRestaurant(grossByEmpRid[empId], employeesById?.[empId]);
  }
  return Math.round(sum * 100) / 100;
}
