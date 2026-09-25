/**
 * Schedule sync v2 (mobile) — mirrors web schedule-sync-v2.js op contract.
 * ISO-dated cells + idempotent ops via apply_schedule_ops RPC.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredCompanyId } from '../companySession';
import { fetchDraftScheduleRowOrderMeta } from '../teamStateColumns';
import {
  loadDraftFromTeamState,
} from './engine';
import { isoAddDaysLocal, isoDaySpanInclusive } from './isoDate';
import { overlayRemoteDraftRowOrderMeta } from './slotOrder';
import type { AssignmentStore } from './types';

const CELL_SELECT =
  'company_id,restaurant_id,day_iso,role,slot_key,start_hhmm,end_hhmm,worker_id,worker_name,break_annotation,break_paid,deleted,rev,updated_at';
const FETCH_PAGE = 1000;
const FETCH_WEEK_BATCH = 6;

const OUTBOX_KEY = 'gm-schedule-ops-outbox-v1';
const DEVICE_KEY = 'gm-schedule-device-id-v1';
const LAST_REV_KEY = 'gm-schedule-last-rev-v1';
const SLOT_MAP_KEY = 'gm-schedule-slot-map-v1';
const WRITE_ONLY_KEY = 'gm-schedule-sync-v2-write-only';

export type ScheduleOpType =
  | 'set_times'
  | 'set_day_off'
  | 'set_worker'
  | 'add_slot'
  | 'reorder_slots'
  | 'deactivate_slot'
  | 'set_week_meta'
  | 'publish_week';

export type ScheduleOp = {
  op_id: string;
  op_type: ScheduleOpType;
  payload: Record<string, unknown>;
};

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(key: string, val: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* ignore */
  }
}

export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = uuid();
    await AsyncStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function makeOp(opType: ScheduleOpType, payload: Record<string, unknown>): ScheduleOp {
  return { op_id: uuid(), op_type: opType, payload };
}

export function opSetTimes(
  restaurantId: string,
  dayIso: string,
  role: string,
  slotKey: string,
  start: string | null,
  end: string | null,
  breakAnnotation?: string | null
): ScheduleOp {
  return makeOp('set_times', {
    restaurant_id: restaurantId,
    day_iso: dayIso,
    role,
    slot_key: slotKey,
    start_hhmm: start,
    end_hhmm: end,
    break_annotation: breakAnnotation ?? null,
  });
}

export function opSetDayOff(
  restaurantId: string,
  dayIso: string,
  role: string,
  slotKey: string,
  workerName?: string | null
): ScheduleOp {
  return makeOp('set_day_off', {
    restaurant_id: restaurantId,
    day_iso: dayIso,
    role,
    slot_key: slotKey,
    ...(workerName ? { worker_name: workerName } : {}),
  });
}

export function opSetWorker(
  restaurantId: string,
  dayIso: string,
  role: string,
  slotKey: string,
  workerName: string | null
): ScheduleOp {
  return makeOp('set_worker', {
    restaurant_id: restaurantId,
    day_iso: dayIso,
    role,
    slot_key: slotKey,
    worker_name: workerName && workerName !== 'Unassigned' ? workerName : null,
  });
}

export function opAddSlot(
  restaurantId: string,
  role: string,
  slotKey: string,
  sortOrder: number
): ScheduleOp {
  return makeOp('add_slot', {
    restaurant_id: restaurantId,
    role,
    slot_key: slotKey,
    sort_order: sortOrder,
  });
}

export function opDeactivateSlot(
  restaurantId: string,
  role: string,
  slotKey: string
): ScheduleOp {
  return makeOp('deactivate_slot', {
    restaurant_id: restaurantId,
    role,
    slot_key: slotKey,
  });
}

export function opReorderSlots(
  restaurantId: string,
  role: string,
  slotKeys: string[]
): ScheduleOp {
  return makeOp('reorder_slots', {
    restaurant_id: restaurantId,
    role,
    slot_keys: slotKeys,
  });
}

export type ScheduleSlotRow = {
  restaurant_id?: string;
  role?: string;
  slot_key?: string;
  sort_order?: number;
  active?: boolean;
};

function slotMapStorageKey(restaurantId: string, role: string, sortOrder: number): string {
  return `${restaurantId}|${role}|${sortOrder}`;
}

function liveTimedCellCountForSlotKey(
  cells: Record<string, unknown>[] | undefined,
  slotKey: string
): number {
  const key = String(slotKey);
  let n = 0;
  (cells || []).forEach((c) => {
    if (!c || c.deleted) return;
    if (String(c.slot_key || '') !== key) return;
    if (c.start_hhmm && c.end_hhmm) n += 1;
  });
  return n;
}

/**
 * Canonical slot_key for restaurant|role|sort_order — prefer the mapped key when it
 * still exists, else the fork that actually has timed cells (web pickStableSlotKey).
 */
export function pickStableSlotKey(
  mapKey: string,
  candidates: string[],
  preferMap: Record<string, string>,
  timedCountForKey: (slotKey: string) => number
): string | null {
  const list = (candidates || []).filter(Boolean).map(String);
  if (!list.length) return null;
  list.sort();
  let richest = list[0];
  let richestN = timedCountForKey(richest);
  for (let i = 1; i < list.length; i += 1) {
    const n = timedCountForKey(list[i]);
    if (n > richestN) {
      richest = list[i];
      richestN = n;
    }
  }
  const prev = preferMap && preferMap[mapKey];
  if (prev && list.indexOf(String(prev)) >= 0) {
    const prevN = timedCountForKey(prev);
    if (prevN >= richestN || richestN < 1) return String(prev);
  }
  return richest;
}

/** Rebuild restaurant|role|trIdx → slot_key from the active cloud slot list. */
export async function bindSlotMapFromFetchedSlots(
  slots: ScheduleSlotRow[],
  cells?: Record<string, unknown>[]
): Promise<Record<string, string>> {
  const prevMap = await readJson<Record<string, string>>(SLOT_MAP_KEY, {});
  if (!slots || !slots.length) return prevMap;
  const bySort: Record<string, string[]> = {};
  (slots || []).forEach((row) => {
    if (!row || row.active === false) return;
    const rid = String(row.restaurant_id || '');
    const role = String(row.role || '');
    const slotKey = String(row.slot_key || '');
    if (!rid || !role || !slotKey) return;
    const mk = slotMapStorageKey(rid, role, Number(row.sort_order) || 0);
    if (!bySort[mk]) bySort[mk] = [];
    bySort[mk].push(slotKey);
  });
  if (!Object.keys(bySort).length) return prevMap;
  const nextMap: Record<string, string> = {};
  const timed = (k: string) => liveTimedCellCountForSlotKey(cells, k);
  Object.keys(bySort).forEach((mk) => {
    const chosen = pickStableSlotKey(mk, bySort[mk], prevMap, timed);
    if (chosen) nextMap[mk] = chosen;
  });
  await writeJson(SLOT_MAP_KEY, nextMap);
  return nextMap;
}

function trIdxForBoundSlotKey(
  restaurantId: string,
  role: string,
  slotKey: string,
  slotMap: Record<string, string>,
  sortOrderByPk: Map<string, number>
): number | null {
  const rid = String(restaurantId || '');
  const roleS = String(role || '');
  const key = String(slotKey || '');
  if (!rid || !roleS || !key) return null;
  let found: number | null = null;
  Object.keys(slotMap || {}).forEach((k) => {
    if (String(slotMap[k]) !== key) return;
    const parts = String(k).split('|');
    if (parts.length < 3) return;
    if (String(parts[0]) !== rid || String(parts[1]) !== roleS) return;
    const n = Number(parts[2]);
    if (!Number.isNaN(n)) found = n;
  });
  if (found != null) return found;
  const so = sortOrderByPk.get(`${rid}\0${roleS}\0${key}`);
  if (so == null || so < 0) return null;
  return Number(so) || 0;
}

function writeWeekRestaurantLayers(
  draft: Record<string, unknown>,
  weekIndex: number,
  restaurantId: string,
  layers: Record<string, unknown>
): void {
  if (!draft.byWeek || typeof draft.byWeek !== 'object') draft.byWeek = {};
  const byWeek = draft.byWeek as Record<string, unknown>;
  const key = String(weekIndex);
  const weekEntry = byWeek[key];
  if (!weekEntry || typeof weekEntry !== 'object') {
    byWeek[key] = { [restaurantId]: layers };
    return;
  }
  const rec = weekEntry as Record<string, unknown>;
  const shared =
    Array.isArray(rec.Bartender) || Array.isArray(rec.Kitchen) || Array.isArray(rec.Server);
  if (shared) {
    byWeek[key] = { [restaurantId]: layers };
    return;
  }
  rec[restaurantId] = layers;
}

function padDraftWeeksFromActiveSlots(
  liveDraft: unknown,
  slots: ScheduleSlotRow[],
  weekIndices: number[]
): unknown {
  if (!weekIndices.length) return liveDraft;
  const maxBy = new Map<string, number>();
  (slots || []).forEach((s) => {
    if (!s || s.active === false) return;
    const rid = String(s.restaurant_id || '');
    const role = String(s.role || '');
    if (!rid || !role) return;
    const k = `${rid}\0${role}`;
    const n = Number(s.sort_order) || 0;
    const prev = maxBy.get(k);
    if (prev == null || n > prev) maxBy.set(k, n);
  });
  if (!maxBy.size) return liveDraft;
  const draft: Record<string, unknown> =
    liveDraft && typeof liveDraft === 'object'
      ? (liveDraft as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  if (!draft.byWeek || typeof draft.byWeek !== 'object') draft.byWeek = {};
  const byWeek = draft.byWeek as Record<string, unknown>;
  const rids = new Set<string>();
  maxBy.forEach((_n, k) => {
    const rid = k.split('\0')[0];
    if (rid) rids.add(rid);
  });
  const nullRow = () => [null, null, null, null, null, null, null];
  const padGrid = (grid: Record<string, unknown>, rid: string) => {
    (['Kitchen', 'Bartender', 'Server'] as const).forEach((role) => {
      const maxSort = maxBy.get(`${rid}\0${role}`);
      if (maxSort == null || maxSort < 0) return;
      const want = maxSort + 1;
      if (!Array.isArray(grid[role])) grid[role] = [];
      const rows = grid[role] as unknown[];
      while (rows.length < want) rows.push(nullRow());
    });
  };
  weekIndices.forEach((wi) => {
    const key = String(wi);
    let weekEntry = byWeek[key];
    if (!weekEntry || typeof weekEntry !== 'object') {
      const perRest: Record<string, unknown> = {};
      rids.forEach((rid) => {
        perRest[rid] = loadDraftFromTeamState(draft, wi, rid);
        padGrid(perRest[rid] as Record<string, unknown>, rid);
      });
      byWeek[key] = perRest;
      return;
    }
    const rec = weekEntry as Record<string, unknown>;
    const sharedLayers =
      Array.isArray(rec.Bartender) || Array.isArray(rec.Kitchen) || Array.isArray(rec.Server);
    if (sharedLayers) {
      rids.forEach((rid) => padGrid(rec, rid));
      return;
    }
    rids.forEach((rid) => {
      if (!rec[rid] || typeof rec[rid] !== 'object') {
        rec[rid] = loadDraftFromTeamState(draft, wi, rid);
      }
      padGrid(rec[rid] as Record<string, unknown>, rid);
    });
  });
  return draft;
}

export async function ensureSlotKey(
  restaurantId: string,
  role: string,
  trIdx: number,
  knownSlots?: {
    restaurant_id?: string;
    role?: string;
    slot_key?: string;
    sort_order?: number;
    active?: boolean;
  }[]
): Promise<string> {
  const map = await readJson<Record<string, string>>(SLOT_MAP_KEY, {});
  const k = `${restaurantId}|${role}|${trIdx}`;
  const candidates = (knownSlots || [])
    .filter(
      (s) =>
        s &&
        s.active !== false &&
        String(s.restaurant_id || '') === String(restaurantId) &&
        String(s.role || '') === String(role) &&
        Number(s.sort_order) === Number(trIdx) &&
        s.slot_key
    )
    .map((s) => String(s.slot_key));
  if (candidates.length) {
    const chosen = pickStableSlotKey(k, candidates, map, () => 0);
    if (chosen) {
      map[k] = chosen;
      await writeJson(SLOT_MAP_KEY, map);
      return chosen;
    }
  }
  if (map[k]) return map[k];
  const sk = uuid();
  map[k] = sk;
  await writeJson(SLOT_MAP_KEY, map);
  return sk;
}

export async function enqueueOps(ops: ScheduleOp[]): Promise<void> {
  if (!ops.length) return;
  const box = await readJson<ScheduleOp[]>(OUTBOX_KEY, []);
  box.push(...ops);
  await writeJson(OUTBOX_KEY, box);
}

export async function flushOutbox(sb: SupabaseClient): Promise<{
  ok: boolean;
  data?: unknown;
  error?: unknown;
}> {
  const box = await readJson<ScheduleOp[]>(OUTBOX_KEY, []);
  if (!box.length) return { ok: true };
  const batch = box.slice(0, 50);
  const device = await getDeviceId();
  const { data, error } = await sb.rpc('apply_schedule_ops', {
    p_ops: batch,
    p_base_rev: null,
    p_device_id: device,
  });
  if (error) return { ok: false, error };
  const appliedIds = new Set<string>();
  const applied = (data as { applied?: { op_id?: string }[] })?.applied || [];
  applied.forEach((a) => {
    if (a?.op_id) appliedIds.add(a.op_id);
  });
  const conflicts = (data as { conflicts?: { op_id?: string; reason?: string }[] })?.conflicts || [];
  const conflictDrop = new Set(
    conflicts.filter((c) => c.reason === 'cell_conflict' && c.op_id).map((c) => c.op_id as string)
  );
  const remain = (await readJson<ScheduleOp[]>(OUTBOX_KEY, [])).filter(
    (op) => !appliedIds.has(op.op_id) && !conflictDrop.has(op.op_id)
  );
  await writeJson(OUTBOX_KEY, remain);
  const rev = (data as { schedule_rev?: number })?.schedule_rev;
  if (rev != null) await writeJson(LAST_REV_KEY, rev);
  return { ok: true, data };
}

/** Drain outbox until empty or max rounds (hard revert). */
export async function flushOutboxFully(
  sb: SupabaseClient,
  maxRounds = 20
): Promise<{ ok: boolean; error?: unknown }> {
  for (let i = 0; i < maxRounds; i += 1) {
    const box = await readJson<ScheduleOp[]>(OUTBOX_KEY, []);
    if (!box.length) return { ok: true };
    const res = await flushOutbox(sb);
    if (!res.ok) return { ok: false, error: res.error };
  }
  const left = await readJson<ScheduleOp[]>(OUTBOX_KEY, []);
  return { ok: !left.length };
}

export type CellsFetchResult = {
  ok: boolean;
  data: Record<string, unknown>[] | null;
  rows: Record<string, unknown>[];
  error: unknown | null;
};

export async function pruneBloatedOutbox(maxKeep = 500): Promise<{
  ok: boolean;
  pruned: boolean;
  before: number;
  after: number;
}> {
  const max = Number.isFinite(maxKeep) ? Math.max(1, Number(maxKeep)) : 500;
  const box = await readJson<ScheduleOp[]>(OUTBOX_KEY, []);
  if (!box.length || box.length <= max) {
    return { ok: true, pruned: false, before: box.length, after: box.length };
  }
  const before = box.length;
  const kept = box.slice(Math.max(0, before - max));
  await writeJson(OUTBOX_KEY, kept);
  return { ok: true, pruned: true, before, after: kept.length };
}

/**
 * Fetch ISO cells. Long windows split into week chunks (6-wide parallel) then page
 * at 1000 rows — same contract as web `fetchCellsRange`.
 */
export async function fetchCellsRange(
  sb: SupabaseClient,
  companyId: string,
  fromIso: string,
  toIso: string,
  opts?: { _noSplit?: boolean }
): Promise<CellsFetchResult> {
  const from = String(fromIso || '').slice(0, 10);
  const to = String(toIso || '').slice(0, 10);
  if (!from || !to) return { ok: false, data: null, rows: [], error: 'missing range' };
  const span = isoDaySpanInclusive(from, to);
  if (span > 8 && !opts?._noSplit) {
    const chunks: { from: string; to: string }[] = [];
    let cur = from;
    while (cur && cur <= to) {
      let chunkEnd = isoAddDaysLocal(cur, 6);
      if (!chunkEnd || chunkEnd > to) chunkEnd = to;
      chunks.push({ from: cur, to: chunkEnd });
      cur = isoAddDaysLocal(chunkEnd, 1);
      if (!cur) break;
    }
    const all: Record<string, unknown>[] = [];
    for (let bi = 0; bi < chunks.length; bi += FETCH_WEEK_BATCH) {
      const slice = chunks.slice(bi, bi + FETCH_WEEK_BATCH);
      const parts = await Promise.all(
        slice.map((c) => fetchCellsRange(sb, companyId, c.from, c.to, { _noSplit: true }))
      );
      for (const part of parts) {
        if (!part || part.ok === false) {
          return part || { ok: false, data: null, rows: [], error: 'cells fetch' };
        }
        all.push(...(part.rows || []));
      }
    }
    return { ok: true, data: all, rows: all, error: null };
  }

  const baseQuery = (useOrder: boolean, start: number) => {
    let q = sb
      .from('schedule_cells')
      .select(CELL_SELECT)
      .eq('deleted', false)
      .gte('day_iso', from)
      .lte('day_iso', to);
    if (companyId) q = q.eq('company_id', companyId);
    if (useOrder) {
      q = q
        .order('day_iso', { ascending: true })
        .order('restaurant_id', { ascending: true })
        .order('role', { ascending: true })
        .order('slot_key', { ascending: true })
        .range(start, start + FETCH_PAGE - 1);
    } else {
      q = q.limit(FETCH_PAGE);
    }
    return q;
  };

  const allShort: Record<string, unknown>[] = [];
  let fromIdx = 0;
  let useOrder = false;
  for (;;) {
    const res = await baseQuery(useOrder, fromIdx);
    if (res.error && fromIdx === 0 && !useOrder) {
      let fallback = sb
        .from('schedule_cells')
        .select(CELL_SELECT)
        .eq('deleted', false)
        .gte('day_iso', from)
        .lte('day_iso', to);
      if (companyId) fallback = fallback.eq('company_id', companyId);
      const fb = await fallback;
      if (fb.error) return { ok: false, data: null, rows: [], error: fb.error };
      const rows = (fb.data || []) as Record<string, unknown>[];
      return { ok: true, data: rows, rows, error: null };
    }
    if (res.error) return { ok: false, data: null, rows: [], error: res.error };
    const chunk = (res.data || []) as Record<string, unknown>[];
    if (!useOrder && chunk.length >= FETCH_PAGE) {
      useOrder = true;
      fromIdx = 0;
      allShort.length = 0;
      continue;
    }
    allShort.push(...chunk);
    if (chunk.length < FETCH_PAGE) break;
    fromIdx += FETCH_PAGE;
    if (fromIdx > 20000) break;
  }
  return { ok: true, data: allShort, rows: allShort, error: null };
}

export async function fetchSlots(sb: SupabaseClient, companyId: string) {
  return sb
    .from('schedule_slots')
    .select('company_id,restaurant_id,role,slot_key,sort_order,label,active')
    .eq('company_id', companyId)
    .eq('active', true);
}

/** Bind cloud slots then resolve restaurant|role|trIdx so edits hit the same UUID as web. */
export async function ensureBoundSlotKey(
  sb: SupabaseClient,
  restaurantId: string,
  role: string,
  trIdx: number
): Promise<string> {
  const companyId = await readStoredCompanyId();
  let known: ScheduleSlotRow[] = [];
  if (companyId) {
    const slotsRes = await fetchSlots(sb, companyId);
    known = (slotsRes.data || []) as ScheduleSlotRow[];
    await bindSlotMapFromFetchedSlots(known);
  }
  return ensureSlotKey(restaurantId, role, trIdx, known);
}

/**
 * Project fetched ISO cells onto legacy assignment + draft stores for one display window.
 * Used when write-only mode ignores team_state schedule blobs.
 */
export function projectCellsOntoLocalStores(opts: {
  cells: Record<string, unknown>[];
  slots: { restaurant_id?: string; role?: string; slot_key?: string; sort_order?: number; active?: boolean }[];
  weekMeta: { iso?: string }[];
  liveAssign: AssignmentStore;
  liveDraft: unknown;
  /** restaurant|role|trIdx → slot_key (from bindSlotMapFromFetchedSlots). */
  slotMap?: Record<string, string>;
  /** When set, replace that week from cells (drop stale local keys). */
  replaceWeekIndex?: number;
  /** Replace every week in `weekMeta` (Refresh / first-open cloud SoT). */
  replaceAllWeeks?: boolean;
}): { assign: AssignmentStore; draft: unknown } {
  const isoToGdi: Record<string, number> = {};
  (opts.weekMeta || []).forEach((m, i) => {
    const iso = m?.iso ? String(m.iso).slice(0, 10) : '';
    if (iso) isoToGdi[iso] = i;
  });
  const roleToIdx: Record<string, number> = { Kitchen: 0, Bartender: 1, Server: 2 };
  const slotTr = new Map<string, number>();
  (opts.slots || []).forEach((s) => {
    if (!s?.restaurant_id || !s.role || !s.slot_key) return;
    if (s.active === false) return;
    slotTr.set(
      `${s.restaurant_id}\0${s.role}\0${s.slot_key}`,
      Number(s.sort_order) || 0
    );
  });
  const slotMap = opts.slotMap || {};
  const nextAssign = JSON.parse(JSON.stringify(opts.liveAssign || {})) as AssignmentStore;
  const nextDraftObj: Record<string, unknown> =
    opts.liveDraft && typeof opts.liveDraft === 'object'
      ? (JSON.parse(JSON.stringify(opts.liveDraft)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  let nextDraft: unknown = nextDraftObj;
  const layersCache = new Map<string, Record<string, unknown>>();
  const layersFor = (wi: number, rid: string): Record<string, unknown> => {
    const ck = `${wi}|${rid}`;
    let layers = layersCache.get(ck);
    if (!layers) {
      layers = loadDraftFromTeamState(nextDraft, wi, rid) as unknown as Record<string, unknown>;
      layersCache.set(ck, layers);
    }
    return layers;
  };

  const projected = new Set<string>();
  const projectedRev = new Map<string, number>();
  (opts.cells || []).forEach((cell) => {
    if (!cell || cell.deleted) return;
    const dayIso = String(cell.day_iso || '').slice(0, 10);
    const gdi = isoToGdi[dayIso];
    if (gdi == null || gdi < 0) return;
    const role = String(cell.role || '');
    const roleIdx = roleToIdx[role];
    if (roleIdx == null) return;
    const rid = String(cell.restaurant_id || '');
    const slotKey = String(cell.slot_key || '');
    if (!rid || !slotKey) return;
    const trIdx = trIdxForBoundSlotKey(rid, role, slotKey, slotMap, slotTr);
    if (trIdx == null || trIdx < 0) return;
    const shiftId = `shift-${gdi}-${roleIdx}-${trIdx}`;
    const projKey = `${rid}\0${shiftId}`;
    const remoteRev = Number(cell.rev) || 0;
    const existingRev = projectedRev.get(projKey);
    if (existingRev != null && existingRev > remoteRev) return;
    projected.add(projKey);
    projectedRev.set(projKey, remoteRev);
    if (!nextAssign[rid]) nextAssign[rid] = {};
    const worker =
      cell.worker_name && String(cell.worker_name) !== 'Unassigned'
        ? String(cell.worker_name)
        : null;
    const start = cell.start_hhmm ? String(cell.start_hhmm) : '';
    const end = cell.end_hhmm ? String(cell.end_hhmm) : '';
    const entry: Record<string, unknown> = {
      workers: worker ? [worker] : ['Unassigned'],
    };
    if (worker) entry.rowOwner = worker;
    if (start && end) {
      entry.break = cell.break_annotation || null;
      if (cell.break_paid === true || cell.break_paid === false) entry.breakPaid = cell.break_paid;
    }
    nextAssign[rid][shiftId] = entry as AssignmentStore[string][string];

    const wi = Math.floor(gdi / 7);
    const di = gdi % 7;
    const layers = layersFor(wi, rid);
    if (!layers[role as 'Bartender' | 'Kitchen' | 'Server']) {
      layers[role] = [];
    }
    const rows = layers[role] as unknown[];
    while (rows.length <= trIdx) {
      rows.push([null, null, null, null, null, null, null]);
    }
    const row = Array.isArray(rows[trIdx])
      ? ([...(rows[trIdx] as unknown[])] as unknown[])
      : [null, null, null, null, null, null, null];
    while (row.length < 7) row.push(null);
    row[di] = start && end ? [start, end] : null;
    rows[trIdx] = row;
  });
  layersCache.forEach((layers, ck) => {
    const sep = ck.indexOf('|');
    const wi = Number(ck.slice(0, sep));
    const rid = ck.slice(sep + 1);
    writeWeekRestaurantLayers(nextDraftObj, wi, rid, layers);
  });
  nextDraft = nextDraftObj;

  const replaceWeeks: number[] = [];
  if (opts.replaceAllWeeks) {
    const n = Math.floor((opts.weekMeta || []).length / 7);
    for (let wi = 0; wi < n; wi += 1) replaceWeeks.push(wi);
  } else if (opts.replaceWeekIndex != null && !Number.isNaN(Number(opts.replaceWeekIndex))) {
    replaceWeeks.push(Number(opts.replaceWeekIndex));
  }
  if (replaceWeeks.length) {
    const weekSet = new Set(replaceWeeks);
    Object.keys(nextAssign).forEach((rid) => {
      const rs = nextAssign[rid];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach((shiftId) => {
        const m = /^shift-(\d+)-/.exec(shiftId);
        if (!m) return;
        const gdi = Number(m[1]);
        const wi = Math.floor(gdi / 7);
        if (!weekSet.has(wi)) return;
        if (!projected.has(`${rid}\0${shiftId}`)) {
          delete rs[shiftId];
        }
      });
    });
    /* Tombstone omitted draft times so leftover local hours cannot soft-win. */
    replaceWeeks.forEach((wi) => {
      const rids = new Set<string>([
        ...Object.keys(nextAssign),
        ...Array.from(slotTr.keys()).map((k) => k.split('\0')[0]),
      ]);
      rids.forEach((rid) => {
        if (!rid) return;
        const ck = `${wi}|${rid}`;
        const layers =
          layersCache.get(ck) ||
          (loadDraftFromTeamState(nextDraft, wi, rid) as unknown as Record<string, unknown>);
        layersCache.set(ck, layers);
        (['Kitchen', 'Bartender', 'Server'] as const).forEach((role) => {
          const rows = layers[role] as unknown[];
          if (!Array.isArray(rows)) return;
          rows.forEach((row, trIdx) => {
            if (!Array.isArray(row)) return;
            const nextRow = [...row];
            let changed = false;
            for (let di = 0; di < 7; di += 1) {
              const gdi = wi * 7 + di;
              const roleIdx = roleToIdx[role];
              const shiftId = `shift-${gdi}-${roleIdx}-${trIdx}`;
              if (!projected.has(`${rid}\0${shiftId}`) && nextRow[di] != null) {
                nextRow[di] = null;
                changed = true;
              }
            }
            if (changed) rows[trIdx] = nextRow;
          });
        });
        writeWeekRestaurantLayers(nextDraftObj, wi, rid, layers);
      });
    });
  }
  nextDraft = nextDraftObj;

  const padWeeks =
    replaceWeeks.length > 0
      ? replaceWeeks
      : (() => {
          const n = Math.floor((opts.weekMeta || []).length / 7);
          const out: number[] = [];
          for (let wi = 0; wi < n; wi += 1) out.push(wi);
          return out;
        })();
  nextDraft = padDraftWeeksFromActiveSlots(nextDraft, opts.slots || [], padWeeks);

  return { assign: nextAssign, draft: nextDraft };
}

export type CloudCellsPullOpts = {
  sb: SupabaseClient;
  companyId: string;
  weekMeta: { iso?: string }[];
  weekIndex: number;
  liveAssign: AssignmentStore;
  liveDraft: unknown;
  /** First-open / Refresh: do not flush leftover outbox (would stamp stale times). */
  cloudAuthority?: boolean;
  fullWindow?: boolean;
  /** Overlay draft_schedule ↑↓ / group / sales from cloud (skip after a local row-order push). */
  applyRowOrderMeta?: boolean;
};

/**
 * Hydrate assignment/draft from cloud cells. Visible week first; full 15-week window
 * when `fullWindow` (Refresh / first open). Cloud replace drops omitted local keys.
 */
export async function pullCloudCellsOntoStores(
  opts: CloudCellsPullOpts
): Promise<{ assign: AssignmentStore; draft: unknown } | null> {
  const fromIso = opts.fullWindow
    ? opts.weekMeta[0]?.iso
    : opts.weekMeta[opts.weekIndex * 7]?.iso;
  const toIso = opts.fullWindow
    ? opts.weekMeta[opts.weekMeta.length - 1]?.iso
    : opts.weekMeta[opts.weekIndex * 7 + 6]?.iso;
  if (!fromIso || !toIso) return null;
  try {
    await pruneBloatedOutbox(500);
    if (!opts.cloudAuthority) {
      await flushOutbox(opts.sb);
    }
    const [cellsRes, slotsRes] = await Promise.all([
      fetchCellsRange(opts.sb, opts.companyId, fromIso, toIso),
      fetchSlots(opts.sb, opts.companyId),
    ]);
    if (!cellsRes.ok || cellsRes.error || slotsRes.error) return null;
    const cells = cellsRes.rows || [];
    const slots = (slotsRes.data || []) as ScheduleSlotRow[];
    const slotMap = await bindSlotMapFromFetchedSlots(slots, cells);
    const projected = projectCellsOntoLocalStores({
      cells,
      slots,
      weekMeta: opts.weekMeta,
      liveAssign: opts.liveAssign,
      liveDraft: opts.liveDraft,
      slotMap,
      replaceWeekIndex: opts.fullWindow ? undefined : opts.weekIndex,
      replaceAllWeeks: !!opts.fullWindow,
    });
    try {
      if (opts.applyRowOrderMeta !== false) {
        const meta = await fetchDraftScheduleRowOrderMeta(opts.sb);
        if (meta) {
          projected.draft = overlayRemoteDraftRowOrderMeta(projected.draft, meta, 'remote');
        }
      }
    } catch (metaErr) {
      console.warn('schedule row-order meta', metaErr);
    }
    return projected;
  } catch (err) {
    console.warn('pullCloudCellsOntoStores', err);
    return null;
  }
}

let documentNeedsCloudSoT = true;

export function consumeDocumentCloudSoT(): boolean {
  const v = documentNeedsCloudSoT;
  documentNeedsCloudSoT = false;
  return v;
}

export function armDocumentCloudSoT(): void {
  documentNeedsCloudSoT = true;
}

/**
 * Paint the visible week from cloud, then overlay the rest of the 15-week window.
 * First-open / Refresh: skip leftover outbox flush so stale ops cannot stamp cloud.
 */
export async function pullCloudCellsVisibleThenFull(opts: {
  sb: SupabaseClient;
  companyId: string;
  weekMeta: { iso?: string }[];
  weekIndex: number;
  liveAssign: AssignmentStore;
  liveDraft: unknown;
  cloudAuthority?: boolean;
  applyRowOrderMeta?: boolean;
  onVisible?: (projected: { assign: AssignmentStore; draft: unknown }) => boolean | void;
}): Promise<{ assign: AssignmentStore; draft: unknown } | null> {
  const visible = await pullCloudCellsOntoStores({
    ...opts,
    fullWindow: false,
    cloudAuthority: opts.cloudAuthority,
    applyRowOrderMeta: opts.applyRowOrderMeta,
  });
  if (!visible) return null;
  if (opts.onVisible) {
    const keepGoing = opts.onVisible(visible);
    if (keepGoing === false) return visible;
  }
  const full = await pullCloudCellsOntoStores({
    sb: opts.sb,
    companyId: opts.companyId,
    weekMeta: opts.weekMeta,
    weekIndex: opts.weekIndex,
    liveAssign: visible.assign,
    liveDraft: visible.draft,
    fullWindow: true,
    cloudAuthority: true,
    applyRowOrderMeta: opts.applyRowOrderMeta,
  });
  return full || visible;
}

/** Subscribe to schedule_cells changes for a company; returns unsubscribe. */
export function subscribeScheduleCells(
  sb: SupabaseClient,
  companyId: string,
  onRows: (rows: Record<string, unknown>[]) => void
): () => void {
  const channel = sb
    .channel('schedule_cells_' + companyId)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'schedule_cells',
        filter: 'company_id=eq.' + companyId,
      },
      (payload) => {
        const row = (payload.new || payload.old) as Record<string, unknown> | null;
        if (row) onRows([row]);
      }
    )
    .subscribe();
  return () => {
    void sb.removeChannel(channel);
  };
}

export async function setWriteOnlyCells(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(WRITE_ONLY_KEY, enabled ? '1' : '0');
}

export async function writeOnlyCells(): Promise<boolean> {
  const v = await AsyncStorage.getItem(WRITE_ONLY_KEY);
  if (v === '0') return false;
  if (v === '1') return true;
  /* Default true after cells cutover — schedule blobs are not SoT. */
  return true;
}

export async function backfillIfNeeded(sb: SupabaseClient, companyId: string) {
  const probe = await sb
    .from('schedule_company_state')
    .select('schedule_rev')
    .eq('company_id', companyId)
    .maybeSingle();
  if (probe.error && /does not exist|relation/i.test(probe.error.message || '')) {
    await setWriteOnlyCells(false);
    return { ok: false, error: probe.error, schemaMissing: true };
  }
  if (probe.data && Number(probe.data.schedule_rev) > 0) {
    await setWriteOnlyCells(true);
    return { ok: true, skipped: true };
  }
  const res = await sb.rpc('backfill_schedule_cells_from_team_state', { p_company_id: companyId });
  if (!res.error) await setWriteOnlyCells(true);
  return res;
}

/** Pure LWW apply for shared contract tests (parity with web schedule-sync-v2). */
export function applyOpsLocal(
  state: {
    rev: number;
    cells: Record<string, Record<string, unknown>>;
    opsSeen: Record<string, boolean>;
  },
  ops: ScheduleOp[],
  opts?: { baseRev?: number | null }
) {
  const next = {
    rev: state.rev || 0,
    cells: { ...state.cells },
    opsSeen: { ...state.opsSeen },
  };
  const applied: unknown[] = [];
  const conflicts: unknown[] = [];
  for (const op of ops) {
    if (!op?.op_id) {
      conflicts.push({ reason: 'missing_op_id' });
      continue;
    }
    if (next.opsSeen[op.op_id]) {
      applied.push({ op_id: op.op_id, duplicate: true });
      continue;
    }
    const p = op.payload || {};
    const ck = [p.restaurant_id, p.day_iso, p.role, p.slot_key].join('\0');
    if (op.op_type === 'set_times' || op.op_type === 'set_day_off' || op.op_type === 'set_worker') {
      const existing = next.cells[ck];
      if (
        opts?.baseRev != null &&
        existing &&
        Number(existing.rev) > Number(opts.baseRev)
      ) {
        conflicts.push({ op_id: op.op_id, reason: 'cell_conflict' });
        continue;
      }
      next.rev += 1;
      const cell: Record<string, unknown> = existing
        ? { ...existing }
        : { deleted: false };
      if (op.op_type === 'set_day_off') {
        cell.start_hhmm = null;
        cell.end_hhmm = null;
        if (p.worker_name) cell.worker_name = p.worker_name;
      } else if (op.op_type === 'set_times') {
        cell.start_hhmm = p.start_hhmm ?? null;
        cell.end_hhmm = p.end_hhmm ?? null;
      } else {
        cell.worker_name = p.worker_name ?? null;
      }
      cell.rev = next.rev;
      cell.deleted = false;
      next.cells[ck] = cell;
    } else {
      next.rev += 1;
    }
    next.opsSeen[op.op_id] = true;
    applied.push({ op_id: op.op_id, rev: next.rev });
  }
  return { state: next, applied, conflicts };
}
