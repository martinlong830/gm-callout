import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { weekBoundsStorageKey } from './payWeek';
import {
  queueTipPayrollPushToSupabase,
  markTimecardTipPoolPendingAck,
  TIMECARD_WEEK_TIP_POOL_KEY,
} from './tipPayrollSync';
import type { LocationFilter } from './restaurantAttribution';
import type { PayWeekBounds } from './types';

/** Default keep rates after platform fees. */
export const TIP_NET_RATE_SQUARE = 0.97;
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
  squareNetRate: TIP_NET_RATE_SQUARE,
  doordashNetRate: TIP_NET_RATE_DELIVERY,
  uberNetRate: TIP_NET_RATE_DELIVERY,
};

export type TipPoolInputs = {
  cashTip: number;
  squareTips: number;
  squarePickup: number;
  doordash: number;
  uber: number;
  sqGhDd: number;
  squareNetRate: number;
  doordashNetRate: number;
  uberNetRate: number;
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
  /** Square In House net (gross × Square keep rate). */
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

/** Keep rate after platform fees. Accepts 0.97 or 97. */
export function normalizeTipPoolRate(val: unknown, fallback = TIP_NET_RATE_SQUARE): number {
  if (val == null || val === '') return fallback;
  let n = parseFloat(String(val));
  if (Number.isNaN(n) || n < 0) return fallback;
  if (n > 1 && n <= 100) n = n / 100;
  if (n > 1) n = 1;
  return Math.round(n * 10000) / 10000;
}

export function formatTipRateInput(rate: unknown): string {
  const n = normalizeTipPoolRate(rate, TIP_NET_RATE_SQUARE);
  let s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  if (s.indexOf('.') < 0) return `${s}.00`;
  if (s.split('.')[1].length === 1) return `${s}0`;
  return s;
}

function tipNetRatesFromPool(pool: TipPoolInputs) {
  return {
    square: normalizeTipPoolRate(pool.squareNetRate, TIP_NET_RATE_SQUARE),
    doordash: normalizeTipPoolRate(pool.doordashNetRate, TIP_NET_RATE_DELIVERY),
    uber: normalizeTipPoolRate(pool.uberNetRate, TIP_NET_RATE_DELIVERY),
  };
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
    squareNetRate: normalizeTipPoolRate(s.squareNetRate, PAYROLL_TIP_POOL_DEFAULTS.squareNetRate),
    doordashNetRate: normalizeTipPoolRate(s.doordashNetRate, PAYROLL_TIP_POOL_DEFAULTS.doordashNetRate),
    uberNetRate: normalizeTipPoolRate(s.uberNetRate, PAYROLL_TIP_POOL_DEFAULTS.uberNetRate),
    manual: !!s.manual,
  };
}

export function payrollTipPoolTotals(pool: TipPoolInputs): TipPoolTotals {
  const p = pool || PAYROLL_TIP_POOL_DEFAULTS;
  const rates = tipNetRatesFromPool(p);
  const squareInhouse = Math.round(p.squareTips * rates.square * 100) / 100;
  const squarePickupNet = Math.round(p.squarePickup * rates.square * 100) / 100;
  const doordashNet = Math.round(p.doordash * rates.doordash * 100) / 100;
  const uberNet = Math.round(p.uber * rates.uber * 100) / 100;
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
    markTimecardTipPoolPendingAck(tipPoolStorageKey(bounds, locationFilter));
    if (isSupabaseConfigured && supabase) {
      queueTipPayrollPushToSupabase(supabase);
    }
  } catch {
    /* ignore */
  }
}

export async function patchWeekTipPoolSlice(
  bounds: PayWeekBounds,
  patch: Partial<TipPoolInputs>,
  locationFilter: LocationFilter = 'rp-9'
): Promise<TipPoolInputs> {
  const existing = await getPayrollTipPoolInputs(bounds, locationFilter);
  const next: TipPoolInputs = { ...existing, ...patch, manual: true };
  if (next.squarePickup > 0 || next.doordash > 0 || next.uber > 0) {
    next.sqGhDd = 0;
  }
  await saveWeekTipPoolSlice(bounds, next, locationFilter);
  return next;
}
