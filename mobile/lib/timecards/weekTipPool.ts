import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { weekBoundsStorageKey } from './payWeek';
import {
  queueTipPayrollPushToSupabase,
  TIMECARD_WEEK_TIP_POOL_KEY,
} from './tipPayrollSync';
import type { LocationFilter } from './restaurantAttribution';
import type { PayWeekBounds } from './types';

/** Net keep rates after platform fees. */
export const TIP_NET_RATE_SQUARE = 0.95;
export const TIP_NET_RATE_DELIVERY = 0.8;

export const PAYROLL_TIP_POOL_DEFAULTS = {
  cashTip: 0,
  /** Square In House tips (gross). */
  squareTips: 0,
  /** Square Pick Up tips (gross). */
  squarePickup: 0,
  /** DoorDash tips (gross). */
  doordash: 0,
  /** Uber Eats tips (gross). */
  uber: 0,
  /**
   * Legacy combined SQ/GH/DD net amount. Used only when platform gross fields are all empty
   * (weeks entered before per-platform breakdown).
   */
  sqGhDd: 0,
};

export type TipPoolInputs = {
  cashTip: number;
  squareTips: number;
  squarePickup: number;
  doordash: number;
  uber: number;
  sqGhDd: number;
  manual?: boolean;
};

export type TipPoolTotals = {
  cashTip: number;
  squareTips: number;
  squarePickup: number;
  doordash: number;
  uber: number;
  squarePickupNet: number;
  doordashNet: number;
  uberNet: number;
  /** Square In House net (gross × 0.95). */
  squareInhouse: number;
  /** Combined SQ Pickup / DD / Uber net (or legacy sqGhDd). */
  sqGhDd: number;
  totalTips: number;
};

function normalizeMoney(val: unknown, fallback = 0): number {
  if (val == null || val === '') return fallback;
  const n = parseFloat(String(val));
  if (Number.isNaN(n) || n < 0) return fallback;
  return Math.round(n * 100) / 100;
}

function tipPoolStorageKey(bounds: PayWeekBounds, locationFilter: LocationFilter = 'rp-9'): string {
  return `${weekBoundsStorageKey(bounds)}|${locationFilter}`;
}

function sliceFromRecord(slice: unknown): TipPoolInputs | null {
  if (!slice || typeof slice !== 'object') return null;
  const s = slice as Record<string, unknown>;
  return {
    cashTip: normalizeMoney(s.cashTip, PAYROLL_TIP_POOL_DEFAULTS.cashTip),
    squareTips: normalizeMoney(s.squareTips, PAYROLL_TIP_POOL_DEFAULTS.squareTips),
    squarePickup: normalizeMoney(s.squarePickup, PAYROLL_TIP_POOL_DEFAULTS.squarePickup),
    doordash: normalizeMoney(s.doordash, PAYROLL_TIP_POOL_DEFAULTS.doordash),
    uber: normalizeMoney(s.uber, PAYROLL_TIP_POOL_DEFAULTS.uber),
    sqGhDd: normalizeMoney(s.sqGhDd, PAYROLL_TIP_POOL_DEFAULTS.sqGhDd),
    manual: !!s.manual,
  };
}

export function payrollTipPoolTotals(pool: TipPoolInputs): TipPoolTotals {
  const p = pool || PAYROLL_TIP_POOL_DEFAULTS;
  const squareInhouse = Math.round(p.squareTips * TIP_NET_RATE_SQUARE * 100) / 100;
  const squarePickupNet = Math.round(p.squarePickup * TIP_NET_RATE_SQUARE * 100) / 100;
  const doordashNet = Math.round(p.doordash * TIP_NET_RATE_DELIVERY * 100) / 100;
  const uberNet = Math.round(p.uber * TIP_NET_RATE_DELIVERY * 100) / 100;
  const hasPlatformGross = p.squarePickup > 0 || p.doordash > 0 || p.uber > 0;
  const sqGhDd = hasPlatformGross
    ? Math.round((squarePickupNet + doordashNet + uberNet) * 100) / 100
    : p.sqGhDd;
  const totalTips = Math.round((p.cashTip + sqGhDd + squareInhouse) * 100) / 100;
  return {
    cashTip: p.cashTip,
    squareTips: p.squareTips,
    squarePickup: p.squarePickup,
    doordash: p.doordash,
    uber: p.uber,
    squarePickupNet,
    doordashNet,
    uberNet,
    squareInhouse,
    sqGhDd,
    totalTips,
  };
}

export async function loadWeekTipPoolSlice(
  bounds: PayWeekBounds,
  locationFilter: LocationFilter = 'rp-9'
): Promise<TipPoolInputs | null> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, unknown>;
    if (!all || typeof all !== 'object') return null;
    const locSlice = sliceFromRecord(all[tipPoolStorageKey(bounds, locationFilter)]);
    if (locSlice) return locSlice;
    // Legacy week-only key (pre location-scoped tip pools).
    return sliceFromRecord(all[weekBoundsStorageKey(bounds)]);
  } catch {
    return null;
  }
}

export async function getPayrollTipPoolInputs(
  bounds: PayWeekBounds,
  locationFilter: LocationFilter = 'rp-9'
): Promise<TipPoolInputs> {
  const slice = await loadWeekTipPoolSlice(bounds, locationFilter);
  if (!slice) return { ...PAYROLL_TIP_POOL_DEFAULTS };
  return slice;
}

export async function saveWeekTipPoolSlice(
  bounds: PayWeekBounds,
  pool: TipPoolInputs,
  locationFilter: LocationFilter = 'rp-9'
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const next = all && typeof all === 'object' ? { ...all } : {};
    const totals = payrollTipPoolTotals(pool);
    next[tipPoolStorageKey(bounds, locationFilter)] = {
      ...pool,
      /* Persist computed SQ/GH/DD so older readers still see the combined net. */
      sqGhDd: totals.sqGhDd,
    };
    await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(next));
    if (isSupabaseConfigured && supabase) {
      queueTipPayrollPushToSupabase(supabase);
    }
  } catch {
    /* ignore */
  }
}
