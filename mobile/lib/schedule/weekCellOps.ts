import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignmentStore, DraftGrid, RoleKey } from './types';
import {
  draftTimeSlotFor,
  loadDraftFromTeamState,
  normalizeScheduleAssignment,
  ROLE_DEFS,
  WEEKDAY_KEYS,
} from './engine';
import {
  enqueueOps,
  ensureSlotKey,
  fetchSlots,
  flushOutboxFully,
  opAddSlot,
  opSetDayOff,
  opSetTimes,
  opSetWorker,
  type ScheduleOp,
} from './syncV2';

/**
 * Push one restaurant-week of draft + assignments onto schedule_cells (cloud SoT).
 * Uses ROLE_DEFS indices (Kitchen=0, Bartender=1, Server=2) — same as web.
 */
export async function enqueueRestaurantWeekCellOps(opts: {
  sb: SupabaseClient;
  companyId: string;
  restaurantId: string;
  weekIndex: number;
  weekMeta: { iso?: string }[];
  draftRaw: unknown;
  assignmentStore: AssignmentStore;
}): Promise<void> {
  const { sb, companyId, restaurantId, weekIndex, weekMeta, draftRaw, assignmentStore } = opts;
  const draft = loadDraftFromTeamState(draftRaw, weekIndex, restaurantId) as DraftGrid;
  const rs = assignmentStore[restaurantId] || {};
  const weekStart = weekIndex * 7;
  const slotsRes = companyId ? await fetchSlots(sb, companyId) : { data: [] as unknown[] };
  const knownSlots = (slotsRes.data || []) as {
    restaurant_id?: string;
    role?: string;
    slot_key?: string;
    sort_order?: number;
    active?: boolean;
  }[];
  const ops: ScheduleOp[] = [];
  for (let roleIdx = 0; roleIdx < ROLE_DEFS.length; roleIdx += 1) {
    const roleKey = ROLE_DEFS[roleIdx].role as RoleKey;
    const rows = draft[roleKey] || [];
    const n = Math.max(rows.length, 1);
    for (let trIdx = 0; trIdx < n; trIdx += 1) {
      const slotKey = await ensureSlotKey(restaurantId, roleKey, trIdx, knownSlots);
      ops.push(opAddSlot(restaurantId, roleKey, slotKey, trIdx));
      for (let di = 0; di < 7; di += 1) {
        const dayIso = weekMeta[weekStart + di]?.iso;
        if (!dayIso) continue;
        const wk = WEEKDAY_KEYS[di];
        const tr = draftTimeSlotFor(draft, roleKey, wk, trIdx);
        const shiftId = `shift-${weekStart + di}-${roleIdx}-${trIdx}`;
        const raw = rs[shiftId];
        const entry = normalizeScheduleAssignment(raw);
        const rawOwner =
          raw && typeof raw === 'object' && !Array.isArray(raw)
            ? String((raw as { rowOwner?: string }).rowOwner || '').trim()
            : '';
        const worker =
          (entry.workers || []).find((w) => w && w !== 'Unassigned') ||
          (rawOwner && rawOwner !== 'Unassigned' ? rawOwner : null);
        if (!tr?.start || !tr?.end) {
          ops.push(opSetDayOff(restaurantId, dayIso, roleKey, slotKey, worker || null));
        } else {
          ops.push(
            opSetTimes(
              restaurantId,
              dayIso,
              roleKey,
              slotKey,
              tr.start,
              tr.end,
              entry.break || null
            )
          );
          ops.push(opSetWorker(restaurantId, dayIso, roleKey, slotKey, worker || null));
        }
      }
    }
  }
  for (let i = 0; i < ops.length; i += 40) {
    await enqueueOps(ops.slice(i, i + 40));
  }
  await flushOutboxFully(sb);
}
