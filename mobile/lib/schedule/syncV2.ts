/**
 * Schedule sync v2 (mobile) — mirrors web schedule-sync-v2.js op contract.
 * ISO-dated cells + idempotent ops via apply_schedule_ops RPC.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SupabaseClient } from '@supabase/supabase-js';

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

export async function ensureSlotKey(
  restaurantId: string,
  role: string,
  trIdx: number
): Promise<string> {
  const map = await readJson<Record<string, string>>(SLOT_MAP_KEY, {});
  const k = `${restaurantId}|${role}|${trIdx}`;
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
  return v === '1';
}

export async function backfillIfNeeded(sb: SupabaseClient, companyId: string) {
  const probe = await sb
    .from('schedule_company_state')
    .select('schedule_rev')
    .eq('company_id', companyId)
    .maybeSingle();
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
      const cell = existing ? { ...existing } : { deleted: false };
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
