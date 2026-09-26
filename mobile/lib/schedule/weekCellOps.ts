import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignmentStore, DraftGrid, RoleKey } from './types';
import {
  draftTimeSlotFor,
  loadDraftFromTeamState,
  normalizeScheduleAssignment,
  parseShiftIdParts,
  ROLE_DEFS,
  WEEKDAY_KEYS,
  buildWeeksFromMonday,
  getScheduleAnchorMondayDate,
  SCHEDULE_VIEW_WEEK_COUNT,
} from './engine';
import { readStoredCompanyId } from '../companySession';
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

/**
 * Stamp schedule_cells for the shifts an approval actually changed
 * (time off, callout, swap). Does not rewrite the rest of the week.
 */
export async function enqueueCellOpsForShiftTargets(opts: {
  sb: SupabaseClient;
  assignmentStore: AssignmentStore;
  draftRaw: unknown;
  targets: { restaurantId: string; shiftId: string }[];
}): Promise<void> {
  const companyId = (await readStoredCompanyId()) || '';
  if (!companyId) {
    throw new Error('Company is not set, so the schedule could not be updated on other devices.');
  }
  const weekMeta = buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate());
  const slotsRes = await fetchSlots(opts.sb, companyId);
  if (slotsRes.error) {
    throw new Error(slotsRes.error.message || 'Could not load schedule rows.');
  }
  const knownSlots = (slotsRes.data || []) as {
    restaurant_id?: string;
    role?: string;
    slot_key?: string;
    sort_order?: number;
    active?: boolean;
  }[];
  const ops: ScheduleOp[] = [];
  const seenSlots = new Set<string>();
  for (const t of opts.targets || []) {
    if (!t?.restaurantId || !t.shiftId) continue;
    const p = parseShiftIdParts(t.shiftId);
    if (!p) continue;
    const roleKey = ROLE_DEFS[p.roleIdx]?.role as RoleKey | undefined;
    if (!roleKey) continue;
    const dayIso = weekMeta[p.globalDayIdx]?.iso;
    if (!dayIso) continue;
    const slotKey = await ensureSlotKey(t.restaurantId, roleKey, p.trIdx, knownSlots);
    const slotSig = `${t.restaurantId}|${roleKey}|${slotKey}`;
    if (!seenSlots.has(slotSig)) {
      seenSlots.add(slotSig);
      ops.push(opAddSlot(t.restaurantId, roleKey, slotKey, p.trIdx));
    }
    const wi = Math.floor(p.globalDayIdx / 7);
    const di = p.globalDayIdx % 7;
    const draft = loadDraftFromTeamState(opts.draftRaw, wi, t.restaurantId) as DraftGrid;
    const tr = draftTimeSlotFor(draft, roleKey, WEEKDAY_KEYS[di], p.trIdx);
    const raw = opts.assignmentStore?.[t.restaurantId]?.[t.shiftId];
    const entry = normalizeScheduleAssignment(raw);
    const worker =
      (entry.workers || []).find((w) => w && w !== 'Unassigned') ||
      (entry.rowOwner && entry.rowOwner !== 'Unassigned' ? entry.rowOwner : null);
    if (!tr?.start || !tr?.end) {
      ops.push(opSetDayOff(t.restaurantId, dayIso, roleKey, slotKey, worker));
    } else {
      ops.push(
        opSetTimes(t.restaurantId, dayIso, roleKey, slotKey, tr.start, tr.end, entry.break || null)
      );
      ops.push(opSetWorker(t.restaurantId, dayIso, roleKey, slotKey, worker));
    }
  }
  if (!ops.length) return;
  await enqueueOps(ops);
  const flushed = await flushOutboxFully(opts.sb);
  if (!flushed.ok) {
    const err = flushed.error;
    const message = err instanceof Error ? err.message : 'Could not sync the schedule.';
    throw new Error(message);
  }
}
