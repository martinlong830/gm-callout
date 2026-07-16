import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from '../companySession';
import { broadcastTeamStateChanged } from '../teamStateSync';

export const TIMECARD_WEEK_TIP_POOL_KEY = 'gm-timecard-week-tip-pool-v1';
export const TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';
export const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';

/** Coalesce tip/VL/SL edits — full payroll JSON blobs are expensive to push. */
const TIP_PAYROLL_PUSH_DEBOUNCE_MS = 4000;

let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Snapshot of tip/VL/SL last applied from (or confirmed to) Supabase. */
let tipPayrollRemoteBaseline: {
  tipPool: Record<string, unknown>;
  dishwasher: Record<string, unknown>;
  weekExtras: Record<string, unknown>;
} = { tipPool: {}, dishwasher: {}, weekExtras: {} };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function tipPayrollSliceJson(slice: unknown): string {
  if (!isRecord(slice)) return '';
  try {
    return JSON.stringify(slice);
  } catch {
    return '';
  }
}

/**
 * Merge tip/VL/SL for push: start from remote SoT, overlay only week keys this device
 * changed since the last remote apply. Prevents one manager's AsyncStorage from
 * clobbering another manager's tip/VL edits.
 */
function mergeTipPayrollStoresForPush(
  localTip: Record<string, unknown>,
  localDw: Record<string, unknown>,
  remoteTip: Record<string, unknown>,
  remoteDw: Record<string, unknown>,
  localExtras: Record<string, unknown>,
  remoteExtras: Record<string, unknown>
): { tipPool: Record<string, unknown>; dishwasher: Record<string, unknown>; weekExtras: Record<string, unknown> } {
  const baseTip = isRecord(tipPayrollRemoteBaseline.tipPool) ? tipPayrollRemoteBaseline.tipPool : {};
  const baseDw = isRecord(tipPayrollRemoteBaseline.dishwasher)
    ? tipPayrollRemoteBaseline.dishwasher
    : {};
  const baseExtras = isRecord(tipPayrollRemoteBaseline.weekExtras)
    ? tipPayrollRemoteBaseline.weekExtras
    : {};
  const mergedTip = { ...remoteTip };
  Object.keys(localTip).forEach((key) => {
    const slice = localTip[key];
    if (!isRecord(slice)) return;
    if (tipPayrollSliceJson(slice) !== tipPayrollSliceJson(baseTip[key])) mergedTip[key] = slice;
  });
  const mergedDw = { ...remoteDw };
  Object.keys(localDw).forEach((key) => {
    const slice = localDw[key];
    if (!isRecord(slice)) return;
    if (tipPayrollSliceJson(slice) !== tipPayrollSliceJson(baseDw[key])) mergedDw[key] = slice;
  });
  const mergedExtras = { ...remoteExtras };
  Object.keys(localExtras).forEach((key) => {
    const slice = localExtras[key];
    if (!isRecord(slice)) return;
    if (tipPayrollSliceJson(slice) !== tipPayrollSliceJson(baseExtras[key])) {
      mergedExtras[key] = slice;
    }
  });
  return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
}

async function snapshotTipPayrollRemoteBaseline(): Promise<void> {
  const [tipPool, dishwasher, weekExtras] = await Promise.all([
    loadTipPoolStore(),
    loadDishwasherTipsStore(),
    loadWeekExtrasStore(),
  ]);
  tipPayrollRemoteBaseline = { tipPool, dishwasher, weekExtras };
}

async function fetchRemoteTipPayrollStores(
  sb: SupabaseClient
): Promise<{ tipPool: Record<string, unknown>; dishwasher: Record<string, unknown>; weekExtras: Record<string, unknown> }> {
  const teamStateId = await readStoredTeamStateId();
  const res = await sb
    .from('team_state')
    .select('timecard_week_tip_pool, timecard_dishwasher_tips, timecard_week_extras')
    .eq('id', teamStateId)
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
  // Snapshot even when remote columns were empty so stale AsyncStorage is not treated as edits.
  await snapshotTipPayrollRemoteBaseline();
  return changed;
}

export function queueTipPayrollPushToSupabase(sb: SupabaseClient | null): void {
  if (!sb) return;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushTipPayrollToSupabase(sb);
  }, TIP_PAYROLL_PUSH_DEBOUNCE_MS);
}

export async function pushTipPayrollToSupabase(sb: SupabaseClient): Promise<void> {
  const teamStateId = await readStoredTeamStateId();
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
      id: teamStateId,
      timecard_week_tip_pool: merged.tipPool,
      timecard_dishwasher_tips: merged.dishwasher,
      timecard_week_extras: merged.weekExtras,
    },
    { onConflict: 'id' }
  );
  if (res.error) {
    console.warn('team_state tip payroll upsert', res.error);
    return;
  }
  tipPayrollRemoteBaseline = {
    tipPool: merged.tipPool,
    dishwasher: merged.dishwasher,
    weekExtras: merged.weekExtras,
  };
  const sess = await sb.auth.getSession();
  await broadcastTeamStateChanged(
    sb,
    teamStateId,
    ['timecard_week_tip_pool', 'timecard_dishwasher_tips', 'timecard_week_extras'],
    sess.data.session?.user.id
  );
}
