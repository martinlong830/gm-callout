import type {
  RoleKey,
  SlotOrderByRestaurant,
  SlotOrderByRole,
  SlotOrderByWeek,
} from './types';
import {
  mergeGroupOrderPotentialByWeekMaps,
  readGroupOrderPotentialByWeek,
} from './groupOrderPotential';

const ROLE_KEYS: RoleKey[] = ['Bartender', 'Kitchen', 'Server'];

export function normalizeMondayIso(iso: unknown): string {
  const s = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/** Normalize a saved trIdx list to cover `0..slotN-1` exactly once. */
export function normalizeSlotOrderList(custom: unknown, slotN: number): number[] | null {
  if (!Array.isArray(custom) || slotN <= 0) return null;
  const seen = new Set<number>();
  const out: number[] = [];
  for (let i = 0; i < custom.length; i += 1) {
    const n = Number(custom[i]);
    if (!Number.isFinite(n)) continue;
    const idx = Math.floor(n);
    if (idx < 0 || idx >= slotN || seen.has(idx)) continue;
    seen.add(idx);
    out.push(idx);
  }
  if (!out.length) return null;
  for (let i = 0; i < slotN; i += 1) {
    if (!seen.has(i)) out.push(i);
  }
  return out;
}

function sanitizeSlotOrderByRoleMap(byRole: unknown): SlotOrderByRole {
  if (!byRole || typeof byRole !== 'object') return {};
  const roleMap: SlotOrderByRole = {};
  ROLE_KEYS.forEach((role) => {
    const list = (byRole as Record<string, unknown>)[role];
    if (Array.isArray(list)) {
      roleMap[role] = list.map((n) => Math.floor(Number(n))).filter((n) => Number.isFinite(n));
    }
  });
  return roleMap;
}

export function sanitizeSlotOrderByRestaurant(raw: unknown): SlotOrderByRestaurant {
  if (!raw || typeof raw !== 'object') return {};
  const out: SlotOrderByRestaurant = {};
  Object.keys(raw as Record<string, unknown>).forEach((rid) => {
    const roleMap = sanitizeSlotOrderByRoleMap((raw as Record<string, unknown>)[rid]);
    if (Object.keys(roleMap).length) out[rid] = roleMap;
  });
  return out;
}

export function sanitizeSlotOrderByWeek(raw: unknown): SlotOrderByWeek {
  if (!raw || typeof raw !== 'object') return {};
  const out: SlotOrderByWeek = {};
  Object.keys(raw as Record<string, unknown>).forEach((weekKey) => {
    const mon = normalizeMondayIso(weekKey);
    if (!mon) return;
    const byRest = sanitizeSlotOrderByRestaurant((raw as Record<string, unknown>)[weekKey]);
    if (Object.keys(byRest).length) out[mon] = byRest;
  });
  return out;
}

/** Legacy global map (pre–per-week). Read-only fallback. */
export function readLegacySlotOrderByRestaurant(draftRaw: unknown): SlotOrderByRestaurant {
  if (!draftRaw || typeof draftRaw !== 'object') return {};
  return sanitizeSlotOrderByRestaurant(
    (draftRaw as { slotOrderByRestaurant?: unknown }).slotOrderByRestaurant
  );
}

export function readSlotOrderByWeek(draftRaw: unknown): SlotOrderByWeek {
  if (!draftRaw || typeof draftRaw !== 'object') return {};
  return sanitizeSlotOrderByWeek((draftRaw as { slotOrderByWeek?: unknown }).slotOrderByWeek);
}

/**
 * Restaurant→role order for one week.
 * Week-specific roles win; missing roles fall back to legacy global `slotOrderByRestaurant`.
 */
export function readSlotOrderByRestaurantForWeek(
  draftRaw: unknown,
  weekMondayIso: string
): SlotOrderByRestaurant {
  const mon = normalizeMondayIso(weekMondayIso);
  const weekMap = mon ? readSlotOrderByWeek(draftRaw)[mon] || {} : {};
  const legacy = readLegacySlotOrderByRestaurant(draftRaw);
  const out: SlotOrderByRestaurant = {};
  const rids = new Set([...Object.keys(legacy), ...Object.keys(weekMap)]);
  rids.forEach((rid) => {
    const roleMap: SlotOrderByRole = {};
    ROLE_KEYS.forEach((role) => {
      const weekList = weekMap[rid]?.[role];
      if (Array.isArray(weekList) && weekList.length) {
        roleMap[role] = weekList.slice();
        return;
      }
      const legacyList = legacy[rid]?.[role];
      if (Array.isArray(legacyList) && legacyList.length) {
        roleMap[role] = legacyList.slice();
      }
    });
    if (Object.keys(roleMap).length) out[rid] = roleMap;
  });
  return out;
}

/** @deprecated Prefer readSlotOrderByRestaurantForWeek — this returns legacy global only. */
export function readSlotOrderByRestaurant(draftRaw: unknown): SlotOrderByRestaurant {
  return readLegacySlotOrderByRestaurant(draftRaw);
}

export function getCustomSlotOrderForRole(
  slotOrderByRestaurant: SlotOrderByRestaurant | null | undefined,
  restaurantId: string,
  role: RoleKey,
  slotN: number
): number[] | null {
  if (!slotOrderByRestaurant || !restaurantId) return null;
  const byRole = slotOrderByRestaurant[restaurantId];
  if (!byRole) return null;
  return normalizeSlotOrderList(byRole[role], slotN);
}

/** Swap `trIdx` one step within a full order list. Returns null if move is a no-op. */
export function moveTrIdxInSlotOrder(
  order: number[],
  trIdx: number,
  direction: -1 | 1
): number[] | null {
  const pos = order.indexOf(trIdx);
  if (pos < 0) return null;
  const nextPos = pos + direction;
  if (nextPos < 0 || nextPos >= order.length) return null;
  const next = order.slice();
  const tmp = next[pos];
  next[pos] = next[nextPos];
  next[nextPos] = tmp;
  return next;
}

/** After deleting draft row `deletedTrIdx`, compact remaining indices in a custom order. */
export function remapSlotOrderAfterDelete(order: number[] | null | undefined, deletedTrIdx: number): number[] {
  const src = Array.isArray(order) ? order : [];
  return src
    .filter((i) => i !== deletedTrIdx)
    .map((i) => (i > deletedTrIdx ? i - 1 : i));
}

/** After appending a new draft row at `newTrIdx`, append it to custom order (if any). */
export function appendSlotToOrder(order: number[] | null | undefined, newTrIdx: number): number[] {
  const src = Array.isArray(order) ? order.slice() : [];
  if (!src.includes(newTrIdx)) src.push(newTrIdx);
  return src;
}

function writeSlotOrderByWeekMap(base: Record<string, unknown>, map: SlotOrderByWeek): void {
  if (Object.keys(map).length) base.slotOrderByWeek = map;
  else delete base.slotOrderByWeek;
}

function roleOrderList(
  byRest: SlotOrderByRestaurant | undefined,
  rid: string,
  role: RoleKey
): number[] | null {
  const list = byRest?.[rid]?.[role];
  return Array.isArray(list) && list.length ? list.slice() : null;
}

/**
 * Merge per-week slot orders. Non-empty side wins when the other is missing/empty.
 * When both have a role list, `preferWhenBoth` chooses the winner (never drop to empty).
 */
export function mergeSlotOrderByWeekMaps(
  localRaw: unknown,
  remoteRaw: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): SlotOrderByWeek {
  const local = sanitizeSlotOrderByWeek(localRaw);
  const remote = sanitizeSlotOrderByWeek(remoteRaw);
  const out: SlotOrderByWeek = {};
  const weekKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  weekKeys.forEach((mon) => {
    const localRest = local[mon] || {};
    const remoteRest = remote[mon] || {};
    const restOut: SlotOrderByRestaurant = {};
    const rids = new Set([...Object.keys(localRest), ...Object.keys(remoteRest)]);
    rids.forEach((rid) => {
      const roleOut: SlotOrderByRole = {};
      ROLE_KEYS.forEach((role) => {
        const locList = roleOrderList(localRest, rid, role);
        const remList = roleOrderList(remoteRest, rid, role);
        if (locList && remList) {
          roleOut[role] = preferWhenBoth === 'local' ? locList : remList;
        } else if (remList) {
          roleOut[role] = remList;
        } else if (locList) {
          roleOut[role] = locList;
        }
      });
      if (Object.keys(roleOut).length) restOut[rid] = roleOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

/** Embed merged slotOrderByWeek into a draft_schedule payload (preserves byWeek / window). */
export function applyMergedSlotOrderToDraft(
  draftRaw: unknown,
  localSlotOrder: unknown,
  remoteSlotOrder: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): unknown {
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  writeSlotOrderByWeekMap(
    base,
    mergeSlotOrderByWeekMaps(localSlotOrder, remoteSlotOrder, preferWhenBoth)
  );
  if (!base.v) base.v = 2;
  return base;
}

/**
 * While a local draft save is pending, keep pending slotOrderByWeek (and byWeek edits)
 * and only absorb structural fields (e.g. windowMondayIso) from a hydrated remote draft.
 */
export function mergePendingDraftWithHydrated(pending: unknown, hydrated: unknown): unknown {
  const p: Record<string, unknown> =
    pending && typeof pending === 'object'
      ? (JSON.parse(JSON.stringify(pending)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  if (!hydrated || typeof hydrated !== 'object') return p;
  const h = hydrated as Record<string, unknown>;
  writeSlotOrderByWeekMap(
    p,
    mergeSlotOrderByWeekMaps(readSlotOrderByWeek(p), readSlotOrderByWeek(h), 'local')
  );
  const mergedGroup = mergeGroupOrderPotentialByWeekMaps(
    readGroupOrderPotentialByWeek(p),
    readGroupOrderPotentialByWeek(h),
    'local'
  );
  if (Object.keys(mergedGroup).length) p.groupOrderPotentialByWeek = mergedGroup;
  else delete p.groupOrderPotentialByWeek;
  const hWin = h.windowMondayIso != null ? String(h.windowMondayIso).slice(0, 10) : '';
  if (hWin) p.windowMondayIso = hWin;
  if (!p.v) p.v = 2;
  return p;
}

/**
 * Merge remote draft_schedule into local cache without letting a missing/empty
 * remote slotOrderByWeek wipe a non-empty local map.
 */
export function mergeDraftScheduleSlotOrderFromRemote(
  localDraft: unknown,
  remoteDraft: unknown
): unknown {
  if (!remoteDraft || typeof remoteDraft !== 'object') return localDraft;
  if (!localDraft || typeof localDraft !== 'object') {
    return JSON.parse(JSON.stringify(remoteDraft));
  }
  const merged = JSON.parse(JSON.stringify(remoteDraft)) as Record<string, unknown>;
  writeSlotOrderByWeekMap(
    merged,
    mergeSlotOrderByWeekMaps(
      readSlotOrderByWeek(localDraft),
      readSlotOrderByWeek(remoteDraft),
      'remote'
    )
  );
  /* Keep legacy global fallback if remote omitted it but local still has it. */
  const localLegacy = readLegacySlotOrderByRestaurant(localDraft);
  const remoteLegacy = readLegacySlotOrderByRestaurant(remoteDraft);
  if (Object.keys(remoteLegacy).length) {
    merged.slotOrderByRestaurant = remoteLegacy;
  } else if (Object.keys(localLegacy).length) {
    merged.slotOrderByRestaurant = localLegacy;
  }
  const mergedGroup = mergeGroupOrderPotentialByWeekMaps(
    readGroupOrderPotentialByWeek(localDraft),
    readGroupOrderPotentialByWeek(remoteDraft),
    'remote'
  );
  if (Object.keys(mergedGroup).length) merged.groupOrderPotentialByWeek = mergedGroup;
  else delete merged.groupOrderPotentialByWeek;
  return merged;
}

/** Write/replace one role's order for a specific week (does not write legacy global). */
export function patchSlotOrderInDraftSchedule(
  raw: unknown,
  weekMondayIso: string,
  restaurantId: string,
  role: RoleKey,
  nextOrder: number[] | null
): unknown {
  const mon = normalizeMondayIso(weekMondayIso);
  if (!mon || !restaurantId) return raw;
  const base: Record<string, unknown> =
    raw && typeof raw === 'object'
      ? (JSON.parse(JSON.stringify(raw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  const map = readSlotOrderByWeek(base);
  if (!map[mon]) map[mon] = {};
  if (!map[mon][restaurantId]) map[mon][restaurantId] = {};
  if (nextOrder == null || !nextOrder.length) {
    delete map[mon][restaurantId][role];
    if (!Object.keys(map[mon][restaurantId]).length) delete map[mon][restaurantId];
    if (!Object.keys(map[mon]).length) delete map[mon];
  } else {
    map[mon][restaurantId][role] = nextOrder.slice();
  }
  writeSlotOrderByWeekMap(base, map);
  if (!base.v) base.v = 2;
  return base;
}

/**
 * Remap custom order for a role after a slot delete on one week.
 * Materializes from legacy fallback into the week map when needed.
 */
export function patchSlotOrderAfterDelete(
  raw: unknown,
  weekMondayIso: string,
  restaurantId: string,
  role: RoleKey,
  deletedTrIdx: number
): unknown {
  const mon = normalizeMondayIso(weekMondayIso);
  if (!mon) return raw;
  const weekOnly = readSlotOrderByWeek(raw)[mon];
  const existingWeek = weekOnly?.[restaurantId]?.[role];
  const existing =
    existingWeek && existingWeek.length
      ? existingWeek
      : readLegacySlotOrderByRestaurant(raw)[restaurantId]?.[role];
  if (!existing || !existing.length) return raw;
  return patchSlotOrderInDraftSchedule(
    raw,
    mon,
    restaurantId,
    role,
    remapSlotOrderAfterDelete(existing, deletedTrIdx)
  );
}

/**
 * Append new slot index to custom order for one week when that role already has a saved order
 * (week-specific or legacy fallback — materializes into the week map).
 */
export function patchSlotOrderAfterAdd(
  raw: unknown,
  weekMondayIso: string,
  restaurantId: string,
  role: RoleKey,
  newTrIdx: number
): unknown {
  const mon = normalizeMondayIso(weekMondayIso);
  if (!mon) return raw;
  const weekOnly = readSlotOrderByWeek(raw)[mon];
  const existingWeek = weekOnly?.[restaurantId]?.[role];
  const existing =
    existingWeek && existingWeek.length
      ? existingWeek
      : readLegacySlotOrderByRestaurant(raw)[restaurantId]?.[role];
  if (!existing || !existing.length) return raw;
  return patchSlotOrderInDraftSchedule(
    raw,
    mon,
    restaurantId,
    role,
    appendSlotToOrder(existing, newTrIdx)
  );
}
