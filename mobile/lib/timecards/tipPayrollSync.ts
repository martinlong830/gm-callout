import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAM_STATE_ROW_ID } from '../constants';

export const TIMECARD_WEEK_TIP_POOL_KEY = 'gm-timecard-week-tip-pool-v1';
export const TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';
export const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';

let pushTimer: ReturnType<typeof setTimeout> | null = null;

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function mergeTipPayrollStoresForPush(
  localTip: Record<string, unknown>,
  localDw: Record<string, unknown>,
  remoteTip: Record<string, unknown>,
  remoteDw: Record<string, unknown>,
  localExtras: Record<string, unknown>,
  remoteExtras: Record<string, unknown>
): { tipPool: Record<string, unknown>; dishwasher: Record<string, unknown>; weekExtras: Record<string, unknown> } {
  const mergedTip = { ...remoteTip };
  Object.keys(localTip).forEach((key) => {
    const slice = localTip[key];
    if (isRecord(slice)) mergedTip[key] = slice;
  });
  const mergedDw = { ...remoteDw };
  Object.keys(localDw).forEach((key) => {
    const slice = localDw[key];
    if (isRecord(slice)) mergedDw[key] = slice;
  });
  const mergedExtras = { ...remoteExtras };
  Object.keys(localExtras).forEach((key) => {
    const slice = localExtras[key];
    if (isRecord(slice)) mergedExtras[key] = slice;
  });
  return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
}

async function fetchRemoteTipPayrollStores(
  sb: SupabaseClient
): Promise<{ tipPool: Record<string, unknown>; dishwasher: Record<string, unknown>; weekExtras: Record<string, unknown> }> {
  const res = await sb
    .from('team_state')
    .select('timecard_week_tip_pool, timecard_dishwasher_tips, timecard_week_extras')
    .eq('id', TEAM_STATE_ROW_ID)
    .maybeSingle();
  if (res.error) {
    console.warn('team_state tip payroll select', res.error);
    return { tipPool: {}, dishwasher: {}, weekExtras: {} };
  }
  const row = res.data;
  return {
    tipPool: isRecord(row?.timecard_week_tip_pool) ? row.timecard_week_tip_pool : {},
    dishwasher: isRecord(row?.timecard_dishwasher_tips) ? row.timecard_dishwasher_tips : {},
    weekExtras: isRecord(row?.timecard_week_extras) ? row.timecard_week_extras : {},
  };
}

export async function loadTipPoolStore(): Promise<Record<string, unknown>> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_TIP_POOL_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadDishwasherTipsStore(): Promise<Record<string, unknown>> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_DISHWASHER_TIPS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function loadWeekExtrasStore(): Promise<Record<string, unknown>> {
  try {
    const raw = await AsyncStorage.getItem(TIMECARD_WEEK_EXTRAS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function applyTipPayrollFromTeamState(
  teamState: Record<string, unknown> | null | undefined
): Promise<boolean> {
  if (!teamState) return false;
  let changed = false;
  const tipPool = teamState.timecard_week_tip_pool;
  if (isRecord(tipPool) && Object.keys(tipPool).length > 0) {
    await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(tipPool));
    changed = true;
  }
  const dishwasher = teamState.timecard_dishwasher_tips;
  if (isRecord(dishwasher) && Object.keys(dishwasher).length > 0) {
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(dishwasher));
    changed = true;
  }
  const weekExtras = teamState.timecard_week_extras;
  if (isRecord(weekExtras) && Object.keys(weekExtras).length > 0) {
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(weekExtras));
    changed = true;
  }
  return changed;
}

export function queueTipPayrollPushToSupabase(sb: SupabaseClient | null): void {
  if (!sb) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushTipPayrollToSupabase(sb);
  }, 700);
}

export async function pushTipPayrollToSupabase(sb: SupabaseClient): Promise<void> {
  const remote = await fetchRemoteTipPayrollStores(sb);
  const [localTip, localDw, localExtras] = await Promise.all([
    loadTipPoolStore(),
    loadDishwasherTipsStore(),
    loadWeekExtrasStore(),
  ]);
  const merged = mergeTipPayrollStoresForPush(
    localTip,
    localDw,
    remote.tipPool,
    remote.dishwasher,
    localExtras,
    remote.weekExtras
  );
  await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
  await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
  await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
  const res = await sb.from('team_state').upsert(
    {
      id: TEAM_STATE_ROW_ID,
      timecard_week_tip_pool: merged.tipPool,
      timecard_dishwasher_tips: merged.dishwasher,
      timecard_week_extras: merged.weekExtras,
    },
    { onConflict: 'id' }
  );
  if (res.error) console.warn('team_state tip payroll upsert', res.error);
}
