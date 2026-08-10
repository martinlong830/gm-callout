import type { EmployeeRow } from '../employees';
import { employeeIsMultiLocation } from '../employees';
import { employeeHomeRestaurant } from './restaurantAttribution';
import { isoFromDate, weekBoundsStorageKey } from './payWeek';
import type { PayWeekBounds } from './types';
import {
  invalidateWeekExtrasSliceCache,
  loadWeekExtrasSlice,
  type WeekExtrasSlice,
} from './weekExtras';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { queueTipPayrollPushToSupabase, TIMECARD_WEEK_EXTRAS_KEY } from './tipPayrollSync';

/** Restaurant id a single-home employee is borrowed to for a pay week. */
export type BorrowRestaurantId = 'rp-8' | 'rp-9';

/**
 * Stored inside the synced week-extras slice under a pipe key so VL/SL parsers ignore it.
 * Value is the restaurant id they are borrowed TO (not their home).
 */
export function borrowStorageKey(empId: string): string {
  return `borrow|${String(empId || '')}`;
}

function isBorrowRestaurantId(val: unknown): val is BorrowRestaurantId {
  return val === 'rp-8' || val === 'rp-9';
}

export function getEmployeeBorrowedRestaurantSync(
  empId: string,
  slice: WeekExtrasSlice
): BorrowRestaurantId | null {
  if (!empId) return null;
  const raw = slice[borrowStorageKey(empId)];
  if (isBorrowRestaurantId(raw)) return raw;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rid = (raw as { restaurantId?: unknown }).restaurantId;
    if (isBorrowRestaurantId(rid)) return rid;
  }
  return null;
}

export async function getEmployeeBorrowedRestaurant(
  empId: string,
  bounds: PayWeekBounds
): Promise<BorrowRestaurantId | null> {
  const slice = await loadWeekExtrasSlice(bounds);
  return getEmployeeBorrowedRestaurantSync(empId, slice);
}

/**
 * Permanent dual-location staff never use week borrow (primary + company-wide OT stay).
 * Single-home staff may be borrowed to the other store for one pay week.
 */
export function employeeEligibleForWeekBorrow(emp: EmployeeRow | null | undefined): boolean {
  if (!emp) return false;
  if (employeeIsMultiLocation(emp.usualRestaurant)) return false;
  const home = employeeHomeRestaurant(emp);
  return home === 'rp-8' || home === 'rp-9';
}

export function employeeUsesSplitOtCaps(
  emp: EmployeeRow | null | undefined,
  borrowedTo: BorrowRestaurantId | null | undefined
): boolean {
  if (!emp || !borrowedTo) return false;
  if (employeeIsMultiLocation(emp.usualRestaurant)) return false;
  const home = employeeHomeRestaurant(emp);
  return (home === 'rp-8' || home === 'rp-9') && home !== borrowedTo;
}

export async function setEmployeeBorrowedRestaurant(
  empId: string,
  bounds: PayWeekBounds,
  restaurantId: BorrowRestaurantId | null
): Promise<void> {
  if (!empId) return;
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const weekKey = weekBoundsStorageKey(bounds);
    const slice =
      all[weekKey] && typeof all[weekKey] === 'object'
        ? ({ ...(all[weekKey] as Record<string, unknown>) } as WeekExtrasSlice)
        : ({} as WeekExtrasSlice);
    const key = borrowStorageKey(empId);
    if (!restaurantId) delete slice[key];
    else slice[key] = restaurantId;
    const next = { ...(all && typeof all === 'object' ? all : {}), [weekKey]: slice };
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(next));
    invalidateWeekExtrasSliceCache(bounds);
    if (isSupabaseConfigured && supabase) queueTipPayrollPushToSupabase(supabase);
  } catch {
    /* ignore */
  }
}

/** Other store id when home is a single restaurant. */
export function siblingRestaurantId(home: string | null | undefined): BorrowRestaurantId | null {
  if (home === 'rp-8') return 'rp-9';
  if (home === 'rp-9') return 'rp-8';
  return null;
}

export function restaurantShortLabel(restaurantId: string | null | undefined): string {
  if (restaurantId === 'rp-8') return '8th Ave';
  if (restaurantId === 'rp-9') return '9th Ave';
  return restaurantId || '—';
}

/** For tests / callers that already have bounds dates as ISO range. */
export function borrowWeekKeyFromBounds(bounds: PayWeekBounds): string {
  return `${isoFromDate(bounds.start)}_${isoFromDate(bounds.end)}`;
}
