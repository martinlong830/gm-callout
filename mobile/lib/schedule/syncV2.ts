/**
 * Schedule sync v2 (mobile) — mirrors web schedule-sync-v2.js op contract.
 * ISO-dated cells + idempotent ops via apply_schedule_ops RPC.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  loadDraftFromTeamState,
  patchDraftScheduleForWeek,
} from './engine';
import type { AssignmentStore } from './types';

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
  if (map[k]) return map[k];
  /* Prefer an existing server slot so mobile does not fork UUIDs vs web. */
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
    .map((s) => String(s.slot_key))
    .sort();
  if (candidates.length) {
    map[k] = candidates[0];
    await writeJson(SLOT_MAP_KEY, map);
    return candidates[0];
  }
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

export async function fetchCellsRange(
  sb: SupabaseClient,
  companyId: string,
  fromIso: string,
  toIso: string
) {
  return sb
    .from('schedule_cells')
    .select('*')
    .eq('company_id', companyId)
    .eq('deleted', false)
    .gte('day_iso', fromIso)
    .lte('day_iso', toIso);
}

export async function fetchSlots(sb: SupabaseClient, companyId: string) {
  return sb
    .from('schedule_slots')
    .select('company_id,restaurant_id,role,slot_key,sort_order,label,active')
    .eq('company_id', companyId)
    .eq('active', true);
}

/**
 * Project fetched ISO cells onto legacy assignment + draft stores for one display window.
 * Used when write-only mode ignores team_state schedule blobs.
 */
export function projectCellsOntoLocalStores(opts: {
  cells: Record<string, unknown>[];
  slots: { restaurant_id?: string; role?: string; slot_key?: string; sort_order?: number }[];
  weekMeta: { iso?: string }[];
  liveAssign: AssignmentStore;
  liveDraft: unknown;
  /** When set, replace that week from cells (drop stale local keys). */
  replaceWeekIndex?: number;
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
    slotTr.set(
      `${s.restaurant_id}\0${s.role}\0${s.slot_key}`,
      Number(s.sort_order) || 0
    );
  });
  const nextAssign = JSON.parse(JSON.stringify(opts.liveAssign || {})) as AssignmentStore;
  let nextDraft: unknown =
    opts.liveDraft && typeof opts.liveDraft === 'object'
      ? JSON.parse(JSON.stringify(opts.liveDraft))
      : { v: 2, byWeek: {} };

  const projected = new Set<string>();
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
    const trIdx = slotTr.get(`${rid}\0${role}\0${slotKey}`);
    if (trIdx == null || trIdx < 0) return;
    const shiftId = `shift-${gdi}-${roleIdx}-${trIdx}`;
    projected.add(`${rid}\0${shiftId}`);
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
    const layers = loadDraftFromTeamState(nextDraft, wi, rid);
    if (!layers[role as 'Bartender' | 'Kitchen' | 'Server']) {
      (layers as Record<string, unknown>)[role] = [];
    }
    const rows = (layers as Record<string, unknown[]>)[role] as unknown[];
    while (rows.length <= trIdx) {
      rows.push([null, null, null, null, null, null, null]);
    }
    const row = Array.isArray(rows[trIdx])
      ? ([...(rows[trIdx] as unknown[])] as unknown[])
      : [null, null, null, null, null, null, null];
    while (row.length < 7) row.push(null);
    row[di] = start && end ? [start, end] : null;
    rows[trIdx] = row;
    nextDraft = patchDraftScheduleForWeek(nextDraft, wi, rid, layers);
  });

  const replaceWi =
    opts.replaceWeekIndex != null && !Number.isNaN(Number(opts.replaceWeekIndex))
      ? Number(opts.replaceWeekIndex)
      : null;
  if (replaceWi != null) {
    const weekStart = replaceWi * 7;
    const weekEnd = weekStart + 7;
    Object.keys(nextAssign).forEach((rid) => {
      const rs = nextAssign[rid];
      if (!rs || typeof rs !== 'object') return;
      Object.keys(rs).forEach((shiftId) => {
        const m = /^shift-(\d+)-/.exec(shiftId);
        if (!m) return;
        const gdi = Number(m[1]);
        if (gdi < weekStart || gdi >= weekEnd) return;
        if (!projected.has(`${rid}\0${shiftId}`)) {
          delete rs[shiftId];
        }
      });
    });
  }

  return { assign: nextAssign, draft: nextDraft };
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
