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
let tipPayrollLastPushOkAt = 0;
/** Pending VL/SL (and tip) day keys not yet echoed from cloud. */
let tipPayrollPendingAckExtras: Record<string, Record<string, true>> = Object.create(null);
const tipPayrollPendingAckTipPool: Record<string, Record<string, true>> = Object.create(null);
const tipPayrollPendingAckDishwasher: Record<string, Record<string, true>> = Object.create(null);
const TIP_PAYROLL_POOL_ACK_KEY = '_pool';
const TIP_PAYROLL_PUSH_MAX_ATTEMPTS = 3;

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

function isTipPayrollLeaveDayKey(k: string): boolean {
  return typeof k === 'string' && /^.+@\d{4}-\d{2}-\d{2}$/.test(k);
}

/**
 * Within one pay-week map (delivery tips / VL-SL extras), overlay only keys this device
 * changed vs baseline. Replacing the whole week object wiped sibling day tips.
 *
 * Leave keys (`empId@YYYY-MM-DD`): ONLY overlay when pending-ack is set (conscious
 * VL/SL edit). Stale local 0/0 must never wipe denser cloud leave on push/soft-merge.
 */
function mergeTipPayrollWeekSliceForPush(
  localSlice: Record<string, unknown>,
  remoteSlice: Record<string, unknown>,
  baselineSlice: Record<string, unknown>,
  pendingDayMap?: Record<string, true> | null
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
    if (isTipPayrollLeaveDayKey(k)) {
      const leavePending = !!(pendingDayMap && pendingDayMap[k]);
      if (!leavePending) continue;
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
      isRecord(baseDw[key]) ? (baseDw[key] as Record<string, unknown>) : {},
      null
    );
  });
  const mergedExtras = { ...remoteExtras };
  Object.keys(localExtras).forEach((key) => {
    const slice = localExtras[key];
    if (!isRecord(slice)) return;
    if (tipPayrollSliceJson(slice) === tipPayrollSliceJson(baseExtras[key])) return;
    const pendingWeek = tipPayrollPendingAckExtras[key];
    mergedExtras[key] = mergeTipPayrollWeekSliceForPush(
      slice,
      isRecord(remoteExtras[key]) ? (remoteExtras[key] as Record<string, unknown>) : {},
      isRecord(baseExtras[key]) ? (baseExtras[key] as Record<string, unknown>) : {},
      pendingWeek || null
    );
  });
  return { tipPool: mergedTip, dishwasher: mergedDw, weekExtras: mergedExtras };
}

function markTipPayrollPendingAckMap(
  pendingMap: Record<string, Record<string, true>>,
  weekKey: string,
  dayKey: string
): void {
  if (!weekKey || !dayKey) return;
  if (!pendingMap[weekKey]) pendingMap[weekKey] = Object.create(null);
  pendingMap[weekKey][dayKey] = true;
}

export function markTipPayrollPendingWeekExtra(weekKey: string, dayKey: string): void {
  markTipPayrollPendingAckMap(tipPayrollPendingAckExtras, weekKey, dayKey);
}

export function markTimecardTipPoolPendingAck(weekKey: string): void {
  if (!weekKey) return;
  markTipPayrollPendingAckMap(tipPayrollPendingAckTipPool, weekKey, TIP_PAYROLL_POOL_ACK_KEY);
}

export function markTimecardDishwasherTipPendingAck(weekKey: string, dayKey: string): void {
  if (!weekKey || !dayKey) return;
  markTipPayrollPendingAckMap(tipPayrollPendingAckDishwasher, weekKey, dayKey);
}

function restoreTipPayrollPendingAckTipPool(
  mergedStore: Record<string, unknown>,
  localStore: Record<string, unknown>,
  pendingMap: Record<string, Record<string, true>>
): Record<string, unknown> {
  Object.keys(pendingMap).forEach((weekKey) => {
    const pendingSlice = pendingMap[weekKey];
    if (!pendingSlice || !pendingSlice[TIP_PAYROLL_POOL_ACK_KEY]) return;
    const localWeek = isRecord(localStore[weekKey]) ? localStore[weekKey] : null;
    if (!localWeek) return;
    mergedStore[weekKey] = { ...localWeek };
  });
  return mergedStore;
}

function clearTipPayrollPendingAckTipPool(
  pendingMap: Record<string, Record<string, true>>,
  remoteStore: Record<string, unknown> | null | undefined,
  localStore?: Record<string, unknown> | null
): void {
  const local = isRecord(localStore) ? localStore : {};
  const remote = isRecord(remoteStore) ? remoteStore : {};
  Object.keys(pendingMap).forEach((weekKey) => {
    const pendingSlice = pendingMap[weekKey];
    if (!pendingSlice || !pendingSlice[TIP_PAYROLL_POOL_ACK_KEY]) return;
    if (tipPayrollSliceJson(local[weekKey]) === tipPayrollSliceJson(remote[weekKey])) {
      delete pendingMap[weekKey];
    }
  });
}

function markPendingAckTipPoolDiffsFromBaseline(
  localStore: Record<string, unknown>,
  baselineStore: Record<string, unknown>,
  pendingMap: Record<string, Record<string, true>>
): void {
  Object.keys(localStore).forEach((weekKey) => {
    if (tipPayrollSliceJson(localStore[weekKey]) === tipPayrollSliceJson(baselineStore[weekKey])) return;
    markTipPayrollPendingAckMap(pendingMap, weekKey, TIP_PAYROLL_POOL_ACK_KEY);
  });
}

function tipPayrollPendingAckNonEmpty(pendingMap: Record<string, Record<string, true>>): boolean {
  return Object.keys(pendingMap).some((weekKey) => {
    const slice = pendingMap[weekKey];
    return !!slice && Object.keys(slice).length > 0;
  });
}

function restoreTipPayrollPendingAckKeys(
  mergedStore: Record<string, unknown>,
  localStore: Record<string, unknown>,
  pendingMap: Record<string, Record<string, true>>
): Record<string, unknown> {
  Object.keys(pendingMap).forEach((weekKey) => {
    const pendingSlice = pendingMap[weekKey];
    if (!pendingSlice) return;
    const localWeek = isRecord(localStore[weekKey]) ? localStore[weekKey] : null;
    if (!localWeek) return;
    const mergedWeek = isRecord(mergedStore[weekKey])
      ? { ...(mergedStore[weekKey] as Record<string, unknown>) }
      : {};
    let touched = false;
    Object.keys(pendingSlice).forEach((dayKey) => {
      if (!Object.prototype.hasOwnProperty.call(localWeek, dayKey)) return;
      mergedWeek[dayKey] = localWeek[dayKey];
      touched = true;
    });
    if (touched) mergedStore[weekKey] = mergedWeek;
  });
  return mergedStore;
}

function clearTipPayrollPendingAckConfirmed(
  pendingMap: Record<string, Record<string, true>>,
  remoteStore: Record<string, unknown> | null | undefined,
  localStore?: Record<string, unknown> | null
): void {
  const local = isRecord(localStore) ? localStore : {};
  Object.keys(pendingMap).forEach((weekKey) => {
    const pendingSlice = pendingMap[weekKey];
    if (!pendingSlice) return;
    const remoteWeek = isRecord(remoteStore?.[weekKey])
      ? (remoteStore![weekKey] as Record<string, unknown>)
      : null;
    const localWeek = isRecord(local[weekKey]) ? (local[weekKey] as Record<string, unknown>) : null;
    Object.keys(pendingSlice).forEach((dayKey) => {
      const localHas = !!(localWeek && Object.prototype.hasOwnProperty.call(localWeek, dayKey));
      const remoteHas = !!(remoteWeek && Object.prototype.hasOwnProperty.call(remoteWeek, dayKey));
      if (localHas) {
        if (
          remoteHas &&
          tipPayrollSliceJson(remoteWeek![dayKey]) === tipPayrollSliceJson(localWeek![dayKey])
        ) {
          delete pendingSlice[dayKey];
        }
        return;
      }
      if (!remoteHas) delete pendingSlice[dayKey];
    });
    if (!Object.keys(pendingSlice).length) delete pendingMap[weekKey];
  });
}

function markPendingAckDiffsFromBaseline(
  localStore: Record<string, unknown>,
  baselineStore: Record<string, unknown>,
  pendingMap: Record<string, Record<string, true>>
): void {
  Object.keys(localStore).forEach((weekKey) => {
    const localWeek = localStore[weekKey];
    if (!isRecord(localWeek)) return;
    const baseWeek = isRecord(baselineStore[weekKey]) ? baselineStore[weekKey] : {};
    Object.keys(localWeek).forEach((dayKey) => {
      if (tipPayrollSliceJson(localWeek[dayKey]) === tipPayrollSliceJson(baseWeek[dayKey])) return;
      /* Never auto-pending VL/SL — conscious writes already mark pending. */
      if (isTipPayrollLeaveDayKey(dayKey)) return;
      markTipPayrollPendingAckMap(pendingMap, weekKey, dayKey);
    });
  });
}

async function fetchRemoteTipPayrollStores(
  sb: SupabaseClient
): Promise<{
  tipPool: Record<string, unknown>;
  dishwasher: Record<string, unknown>;
  weekExtras: Record<string, unknown>;
  updatedAt: string | null;
}> {
  const teamStateId = await readStoredTeamStateId();
  const res = await sb
    .from('team_state')
    .select('timecard_week_tip_pool, timecard_dishwasher_tips, timecard_week_extras, updated_at')
    .eq('id', teamStateId)
    .maybeSingle();
  if (res.error) {
    console.warn('team_state tip payroll select', res.error);
    return { tipPool: {}, dishwasher: {}, weekExtras: {}, updatedAt: null };
  }
  const row = res.data;
  return {
    tipPool: isRecord(row?.timecard_week_tip_pool) ? row.timecard_week_tip_pool : {},
    dishwasher: isRecord(row?.timecard_dishwasher_tips) ? row.timecard_dishwasher_tips : {},
    weekExtras: isRecord(row?.timecard_week_extras) ? row.timecard_week_extras : {},
    updatedAt: row?.updated_at != null ? String(row.updated_at) : null,
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
  if (tipPayrollLastPushOkAt && Date.now() - tipPayrollLastPushOkAt < 5000) {
    return false;
  }
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

  if (remoteExtras) {
    clearTipPayrollPendingAckConfirmed(
      tipPayrollPendingAckExtras,
      remoteExtras,
      await loadWeekExtrasStore()
    );
  }
  if (remoteTip) {
    clearTipPayrollPendingAckTipPool(tipPayrollPendingAckTipPool, remoteTip, await loadTipPoolStore());
  }
  if (remoteDw) {
    clearTipPayrollPendingAckConfirmed(
      tipPayrollPendingAckDishwasher,
      remoteDw,
      await loadDishwasherTipsStore()
    );
  }

  if (!tipPayrollBaselineReady) {
    const localTip0 = await loadTipPoolStore();
    const localDw0 = await loadDishwasherTipsStore();
    const localExtras0 = await loadWeekExtrasStore();
    tipPayrollRemoteBaseline = { tipPool: {}, dishwasher: {}, weekExtras: {} };
    const mergedFirst = mergeTipPayrollStoresForPush(
      localTip0,
      localDw0,
      remoteTip || {},
      remoteDw || {},
      localExtras0,
      remoteExtras || {}
    );
    restoreTipPayrollPendingAckKeys(mergedFirst.weekExtras, localExtras0, tipPayrollPendingAckExtras);
    restoreTipPayrollPendingAckTipPool(mergedFirst.tipPool, localTip0, tipPayrollPendingAckTipPool);
    restoreTipPayrollPendingAckKeys(mergedFirst.dishwasher, localDw0, tipPayrollPendingAckDishwasher);
    let changed = false;
    if (remoteTip || Object.keys(localTip0).length) {
      await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(mergedFirst.tipPool));
      changed = true;
    }
    if (remoteDw || Object.keys(localDw0).length) {
      await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(mergedFirst.dishwasher));
      changed = true;
    }
    if (
      remoteExtras ||
      Object.keys(localExtras0).length ||
      tipPayrollPendingAckNonEmpty(tipPayrollPendingAckExtras)
    ) {
      await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(mergedFirst.weekExtras));
      changed = true;
    }
    tipPayrollRemoteBaseline = {
      tipPool: hasTipPool ? remoteTip || {} : {},
      dishwasher: hasDishwasher ? remoteDw || {} : {},
      /* Never seed week-extras baseline from local — that blocked push diffs. */
      weekExtras: hasWeekExtras ? remoteExtras || {} : {},
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
  restoreTipPayrollPendingAckKeys(merged.weekExtras, localExtras, tipPayrollPendingAckExtras);
  restoreTipPayrollPendingAckTipPool(merged.tipPool, localTip, tipPayrollPendingAckTipPool);
  restoreTipPayrollPendingAckKeys(merged.dishwasher, localDw, tipPayrollPendingAckDishwasher);
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
  } else if (hasTipPool && tipPayrollPendingAckNonEmpty(tipPayrollPendingAckTipPool)) {
    await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
    nextBaseline.tipPool = remoteTip || {};
    changed = true;
  }
  if (hasDishwasher && remoteDw && Object.keys(remoteDw).length > 0) {
    await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
    nextBaseline.dishwasher = remoteDw;
    changed = true;
  }
  if (hasWeekExtras && remoteExtras && Object.keys(remoteExtras).length > 0) {
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
    /* Baseline stays remote SoT — never merged (avoids local===baseline VL/SL wipe). */
    nextBaseline.weekExtras = remoteExtras;
    changed = true;
  } else if (
    hasWeekExtras &&
    tipPayrollPendingAckNonEmpty(tipPayrollPendingAckExtras) &&
    Object.keys(localExtras).length
  ) {
    await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
    nextBaseline.weekExtras = remoteExtras || {};
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

export function flushTipPayrollPushToSupabase(sb: SupabaseClient | null): Promise<void> {
  if (!sb) return Promise.resolve();
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  return pushTipPayrollToSupabase(sb);
}

export async function pushTipPayrollToSupabase(sb: SupabaseClient): Promise<void> {
  if (pushInFlight) {
    pushQueued = true;
    return;
  }
  pushInFlight = true;
  try {
    const teamStateId = await readStoredTeamStateId();
    const baseExtrasBefore = isRecord(tipPayrollRemoteBaseline.weekExtras)
      ? tipPayrollRemoteBaseline.weekExtras
      : {};
    const baseTipBefore = isRecord(tipPayrollRemoteBaseline.tipPool)
      ? tipPayrollRemoteBaseline.tipPool
      : {};
    const baseDwBefore = isRecord(tipPayrollRemoteBaseline.dishwasher)
      ? tipPayrollRemoteBaseline.dishwasher
      : {};
    let localExtras = await loadWeekExtrasStore();
    const localTipBefore = await loadTipPoolStore();
    const localDwBefore = await loadDishwasherTipsStore();
    markPendingAckDiffsFromBaseline(localExtras, baseExtrasBefore, tipPayrollPendingAckExtras);
    markPendingAckTipPoolDiffsFromBaseline(localTipBefore, baseTipBefore, tipPayrollPendingAckTipPool);
    markPendingAckDiffsFromBaseline(localDwBefore, baseDwBefore, tipPayrollPendingAckDishwasher);

    let merged: {
      tipPool: Record<string, unknown>;
      dishwasher: Record<string, unknown>;
      weekExtras: Record<string, unknown>;
    } | null = null;
    let lastError: { message?: string } | null = null;

    for (let attempt = 0; attempt < TIP_PAYROLL_PUSH_MAX_ATTEMPTS; attempt += 1) {
      const remote = await fetchRemoteTipPayrollStores(sb);
      const [localTip, localDw, localExtrasAttempt] = await Promise.all([
        loadTipPoolStore(),
        loadDishwasherTipsStore(),
        loadWeekExtrasStore(),
      ]);
      localExtras = localExtrasAttempt;
      merged = mergeTipPayrollStoresForPush(
        localTip,
        localDw,
        remote.tipPool,
        remote.dishwasher,
        localExtras,
        remote.weekExtras
      );
      restoreTipPayrollPendingAckKeys(merged.weekExtras, localExtras, tipPayrollPendingAckExtras);
      restoreTipPayrollPendingAckTipPool(merged.tipPool, localTip, tipPayrollPendingAckTipPool);
      restoreTipPayrollPendingAckKeys(merged.dishwasher, localDw, tipPayrollPendingAckDishwasher);
      await AsyncStorage.setItem(TIMECARD_WEEK_TIP_POOL_KEY, JSON.stringify(merged.tipPool));
      await AsyncStorage.setItem(TIMECARD_DISHWASHER_TIPS_KEY, JSON.stringify(merged.dishwasher));
      await AsyncStorage.setItem(TIMECARD_WEEK_EXTRAS_KEY, JSON.stringify(merged.weekExtras));
      const tipPayload = {
        timecard_week_tip_pool: merged.tipPool,
        timecard_dishwasher_tips: merged.dishwasher,
        timecard_week_extras: merged.weekExtras,
      };
      let res;
      if (remote.updatedAt) {
        res = await sb
          .from('team_state')
          .update(tipPayload)
          .eq('id', teamStateId)
          .eq('updated_at', remote.updatedAt)
          .select('id, updated_at')
          .maybeSingle();
        if (!res.error && !res.data) {
          if (attempt < TIP_PAYROLL_PUSH_MAX_ATTEMPTS - 1) continue;
          res = await sb
            .from('team_state')
            .upsert({ id: teamStateId, ...tipPayload }, { onConflict: 'id' })
            .select('id, updated_at')
            .single();
        }
      } else {
        res = await sb
          .from('team_state')
          .upsert({ id: teamStateId, ...tipPayload }, { onConflict: 'id' })
          .select('id, updated_at')
          .single();
      }
      if (res.error) {
        lastError = res.error;
        break;
      }
      lastError = null;
      if (
        attempt < TIP_PAYROLL_PUSH_MAX_ATTEMPTS - 1 &&
        (tipPayrollPendingAckNonEmpty(tipPayrollPendingAckExtras) ||
          tipPayrollPendingAckNonEmpty(tipPayrollPendingAckTipPool) ||
          tipPayrollPendingAckNonEmpty(tipPayrollPendingAckDishwasher))
      ) {
        const verify = await fetchRemoteTipPayrollStores(sb);
        clearTipPayrollPendingAckConfirmed(
          tipPayrollPendingAckExtras,
          verify.weekExtras,
          localExtras
        );
        clearTipPayrollPendingAckTipPool(tipPayrollPendingAckTipPool, verify.tipPool, localTip);
        clearTipPayrollPendingAckConfirmed(
          tipPayrollPendingAckDishwasher,
          verify.dishwasher,
          localDw
        );
        if (
          !tipPayrollPendingAckNonEmpty(tipPayrollPendingAckExtras) &&
          !tipPayrollPendingAckNonEmpty(tipPayrollPendingAckTipPool) &&
          !tipPayrollPendingAckNonEmpty(tipPayrollPendingAckDishwasher)
        ) {
          tipPayrollRemoteBaseline = {
            tipPool: verify.tipPool,
            dishwasher: verify.dishwasher,
            weekExtras: verify.weekExtras,
          };
          tipPayrollBaselineReady = true;
          tipPayrollLastPushOkAt = Date.now();
          break;
        }
        continue;
      }
      break;
    }

    if (lastError) {
      console.warn('team_state tip payroll upsert', lastError);
      return;
    }
    if (!merged) return;
    const postVerify = await fetchRemoteTipPayrollStores(sb);
    clearTipPayrollPendingAckConfirmed(
      tipPayrollPendingAckExtras,
      postVerify.weekExtras,
      await loadWeekExtrasStore()
    );
    clearTipPayrollPendingAckTipPool(
      tipPayrollPendingAckTipPool,
      postVerify.tipPool,
      await loadTipPoolStore()
    );
    clearTipPayrollPendingAckConfirmed(
      tipPayrollPendingAckDishwasher,
      postVerify.dishwasher,
      await loadDishwasherTipsStore()
    );
    tipPayrollRemoteBaseline = {
      tipPool: postVerify.tipPool,
      dishwasher: postVerify.dishwasher,
      weekExtras: postVerify.weekExtras,
    };
    tipPayrollBaselineReady = true;
    tipPayrollLastPushOkAt = Date.now();
    const sess = await sb.auth.getSession();
    await broadcastTeamStateChanged(
      sb,
      teamStateId,
      ['timecard_week_tip_pool', 'timecard_dishwasher_tips', 'timecard_week_extras'],
      sess.data.session?.user.id
    );
    if (
      tipPayrollPendingAckNonEmpty(tipPayrollPendingAckExtras) ||
      tipPayrollPendingAckNonEmpty(tipPayrollPendingAckTipPool) ||
      tipPayrollPendingAckNonEmpty(tipPayrollPendingAckDishwasher)
    ) {
      queueTipPayrollPushToSupabase(sb);
    }
  } finally {
    pushInFlight = false;
    if (pushQueued) {
      pushQueued = false;
      void pushTipPayrollToSupabase(sb);
    }
  }
}
