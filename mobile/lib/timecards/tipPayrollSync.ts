import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { AppState, type AppStateStatus } from 'react-native';
import { readStoredTeamStateId } from '../companySession';
import { broadcastTeamStateChanged } from '../teamStateSync';

export const TIMECARD_WEEK_TIP_POOL_KEY = 'gm-timecard-week-tip-pool-v1';
export const TIMECARD_DISHWASHER_TIPS_KEY = 'gm-timecard-dishwasher-tips-v1';
export const TIMECARD_WEEK_EXTRAS_KEY = 'gm-timecard-week-extras-v1';

/** Coalesce tip/VL/SL edits — full payroll JSON blobs are expensive to push. */
const TIP_PAYROLL_PUSH_DEBOUNCE_MS = 1200;

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let pushQueued = false;
let tipPayrollBaselineReady = false;
let appStateFlushBound = false;

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
  if (slice == null) return '';
  try {
    return JSON.stringify(slice);
  } catch {
    return typeof slice === 'string' ? slice : '';
  }
}

/**
 * Within one pay-week map (delivery tips / VL-SL extras), overlay only keys this device
 * changed vs baseline. Replacing the whole week object wiped sibling day tips.
 */
function mergeTipPayrollWeekSliceForPush(
  localSlice: Record<string, unknown>,
  remoteSlice: Record<string, unknown>,
  baselineSlice: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...remoteSlice };
  const keys = new Set([...Object.keys(localSlice), ...Object.keys(baselineSlice)]);
  for (const k of keys) {
    const localHas = Object.prototype.hasOwnProperty.call(localSlice, k);
    const baseHas = Object.prototype.hasOwnProperty.call(baselineSlice, k);
    const localVal = localHas ? localSlice[k] : undefined;
    const baseVal = baseHas ? baselineSlice[k] : undefined;
    if (localHas === baseHas && tipPayrollSliceJson(localVal) === tipPayrollSliceJson(baseVal)) {
      continue;
    }
    if (!localHas) delete merged[k];
    else merged[k] = localVal;
  }
  return merged;
}

/**
 * Merge tip/VL/SL for push: start from remote SoT, overlay only keys this device
 * changed since the last remote apply. Tip-pool weeks stay whole-object; dishwasher tips
 * + week extras deep-merge per day key so saving day B does not drop day A.
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
    if (tipPayrollSliceJson(slice) === tipPayrollSliceJson(baseDw[key])) return;
    mergedDw[key] = mergeTipPayrollWeekSliceForPush(
      slice,
      isRecord(remoteDw[key]) ? (remoteDw[key] as Record<string, unknown>) : {},
      isRecord(baseDw[key]) ? (baseDw[key] as Record<string, unknown>) : {}
    );
  });
  const mergedExtras = { ...remoteExtras };
  Object.keys(localExtras).forEach((key) => {
    const slice = localExtras[key];
    if (!isRecord(slice)) return;
    if (tipPayrollSliceJson(slice) === tipPayrollSliceJson(baseExtras[key])) return;
    mergedExtras[key] = mergeTipPayrollWeekSliceForPush(
      slice,
      isRecord(remoteExtras[key]) ? (remoteExtras[key] as Record<string, unknown>) : {},
      isRecord(baseExtras[key]) ? (baseExtras[key] as Record<string, unknown>) : {}
    );
  });
  return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
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
  const hasTipPool = Object.prototype.hasOwnProperty.call(teamState, 'timecard_week_tip_pool');
  const hasDishwasher = Object.prototype.hasOwnProperty.call(teamState, 'timecard_dishwasher_tips');
  const hasWeekExtras = Object.prototype.hasOwnProperty.call(teamState, 'timecard_week_extras');
  const remoteTip =
    hasTipPool && isRecord(teamState.timecard_week_tip_pool) ? teamState.timecard_week_tip_pool : null;
  const remoteDw =
    hasDishwasher && isRecord(teamState.timecard_dishwasher_tips)
      ? teamState.timecard_dishwasher_tips
      : null;
  const remoteExtras =
    hasWeekExtras && isRecord(teamState.timecard_week_extras) ? teamState.timecard_week_extras : null;

  if (!tipPayrollBaselineReady) {
    let changed = false;
    if (remoteTip && Object.keys(remoteTip).length > 0) {
      await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(remoteTip));
      changed = true;
    }
    if (remoteDw && Object.keys(remoteDw).length > 0) {
      await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(remoteDw));
      changed = true;
    }
    if (remoteExtras && Object.keys(remoteExtras).length > 0) {
      await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(remoteExtras));
      changed = true;
    }
    tipPayrollRemoteBaseline = {
      tipPool: remoteTip || (await loadTipPoolStore()),
      dishwasher: remoteDw || (await loadDishwasherTipsStore()),
      weekExtras: remoteExtras || (await loadWeekExtrasStore()),
    };
    tipPayrollBaselineReady = true;
    return changed;
  }

  const localTip = await loadTipPoolStore();
  const localDw = await loadDishwasherTipsStore();
  const localExtras = await loadWeekExtrasStore();
  const merged = mergeTipPayrollStoresForPush(
    localTip,
    localDw,
    remoteTip || localTip,
    remoteDw || localDw,
    localExtras,
    remoteExtras || localExtras
  );
  const nextBaseline = {
    tipPool: tipPayrollRemoteBaseline.tipPool,
    dishwasher: tipPayrollRemoteBaseline.dishwasher,
    weekExtras: tipPayrollRemoteBaseline.weekExtras,
  };
  let changed = false;
  if (hasTipPool && remoteTip && Object.keys(remoteTip).length > 0) {
    await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
    nextBaseline.tipPool = remoteTip;
    changed = true;
  }
  if (hasDishwasher && remoteDw && Object.keys(remoteDw).length > 0) {
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
    nextBaseline.dishwasher = remoteDw;
    changed = true;
  }
  if (hasWeekExtras && remoteExtras && Object.keys(remoteExtras).length > 0) {
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
    nextBaseline.weekExtras = remoteExtras;
    changed = true;
  }
  tipPayrollRemoteBaseline = nextBaseline;
  return changed;
}

function ensureAppStateFlushBound(sb: SupabaseClient): void {
  if (appStateFlushBound) return;
  appStateFlushBound = true;
  AppState.addEventListener('change', (state: AppStateStatus) => {
    if (state === 'background' || state === 'inactive') {
      flushTipPayrollPushToSupabase(sb);
    }
  });
}

export function queueTipPayrollPushToSupabase(sb: SupabaseClient | null): void {
  if (!sb) return;
  ensureAppStateFlushBound(sb);
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushTipPayrollToSupabase(sb);
  }, TIP_PAYROLL_PUSH_DEBOUNCE_MS);
}

export function flushTipPayrollPushToSupabase(sb: SupabaseClient | null): void {
  if (!sb) return;
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  void pushTipPayrollToSupabase(sb);
}

export async function pushTipPayrollToSupabase(sb: SupabaseClient): Promise<void> {
  if (pushInFlight) {
    pushQueued = true;
    return;
  }
  pushInFlight = true;
  try {
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
    tipPayrollBaselineReady = true;
    const sess = await sb.auth.getSession();
    await broadcastTeamStateChanged(
      sb,
      teamStateId,
      ['timecard_week_tip_pool', 'timecard_dishwasher_tips', 'timecard_week_extras'],
      sess.data.session?.user.id
    );
  } finally {
    pushInFlight = false;
    if (pushQueued) {
      pushQueued = false;
      void pushTipPayrollToSupabase(sb);
    }
  }
}
