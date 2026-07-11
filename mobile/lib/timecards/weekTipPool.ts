import AsyncStorage from '@react-native-async-storage/async-storage';
import { isSupabaseConfigured, supabase } from '../supabase';
import { weekBoundsStorageKey } from './payWeek';
import {
  queueTipPayrollPushToSupabase,
  TIMECARD_WEEK_TIP_POOL_KEY,
} from './tipPayrollSync';
import type { LocationFilter } from './restaurantAttribution';
import type { PayWeekBounds } from './types';

export const PAYROLL_TIP_POOL_DEFAULTS = {
  cashTip: 0,
  sqGhDd: 0,
  squareTips: 0,
  feePercent: 0.03,
};

export type TipPoolInputs = {
  cashTip: number;
  sqGhDd: number;
  squareTips: number;
  feePercent: number;
  manual?: boolean;
};

export type TipPoolTotals = {
  cashTip: number;
  sqGhDd: number;
  squareTips: number;
  feePercent: number;
  feeAmount: number;
  squareInhouse: number;
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
    sqGhDd: normalizeMoney(s.sqGhDd, PAYROLL_TIP_POOL_DEFAULTS.sqGhDd),
    squareTips: normalizeMoney(s.squareTips, PAYROLL_TIP_POOL_DEFAULTS.squareTips),
    feePercent:
      s.feePercent != null && !Number.isNaN(Number(s.feePercent))
        ? Number(s.feePercent)
        : PAYROLL_TIP_POOL_DEFAULTS.feePercent,
    manual: !!s.manual,
  };
}

export function payrollTipPoolTotals(pool: TipPoolInputs): TipPoolTotals {
  const p = pool || PAYROLL_TIP_POOL_DEFAULTS;
  const feeAmount = Math.round(p.squareTips * p.feePercent * 100) / 100;
  const squareInhouse = Math.round(p.squareTips * (1 - p.feePercent) * 100) / 100;
  const totalTips = p.cashTip + p.sqGhDd + squareInhouse;
  return {
    cashTip: p.cashTip,
    sqGhDd: p.sqGhDd,
    squareTips: p.squareTips,
    feePercent: p.feePercent,
    feeAmount,
    squareInhouse,
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
    next[tipPoolStorageKey(bounds, locationFilter)] = pool;
    await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(next));
    if (isSupabaseConfigured && supabase) {
      queueTipPayrollPushToSupabase(supabase);
    }
  } catch {
    /* ignore */
  }
}
