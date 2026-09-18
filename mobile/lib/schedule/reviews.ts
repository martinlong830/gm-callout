import type { SupabaseClient } from '@supabase/supabase-js';
import type { AssignmentStore } from './types';

export type ScheduleReviewStatus = 'pending_admin' | 'pending_manager' | 'accepted' | 'cancelled';

export type ScheduleReviewActor = {
  id: string;
  name: string;
  role: string;
};

export type ScheduleReviewItem = {
  id: string;
  restaurantId: string;
  weekMondayIso: string;
  weekIndexAtSend: number | null;
  status: ScheduleReviewStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: ScheduleReviewActor;
  lastActor: ScheduleReviewActor;
  proposal: { draft: unknown; assignments: AssignmentStore };
};

export type ScheduleReviewsState = { v: 1; items: ScheduleReviewItem[] };

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `rev-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function actor(raw: unknown): ScheduleReviewActor {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    id: String(o.id || ''),
    name: String(o.name || ''),
    role: o.role === 'admin' ? 'admin' : 'manager',
  };
}

function normalizeItem(raw: unknown): ScheduleReviewItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const rec = raw as Record<string, unknown>;
  const status = String(rec.status || '') as ScheduleReviewStatus;
  if (
    status !== 'pending_admin' &&
    status !== 'pending_manager' &&
    status !== 'accepted' &&
    status !== 'cancelled'
  ) {
    return null;
  }
  const createdBy = actor(rec.createdBy);
  const proposalRaw = rec.proposal && typeof rec.proposal === 'object' ? rec.proposal as Record<string, unknown> : {};
  return {
    id: String(rec.id || uuid()),
    restaurantId: String(rec.restaurantId || 'rp-9'),
    weekMondayIso: String(rec.weekMondayIso || '').slice(0, 10),
    weekIndexAtSend:
      rec.weekIndexAtSend != null && !Number.isNaN(Number(rec.weekIndexAtSend))
        ? Number(rec.weekIndexAtSend)
        : null,
    status,
    createdAt: String(rec.createdAt || ''),
    updatedAt: String(rec.updatedAt || ''),
    createdBy,
    lastActor: rec.lastActor ? actor(rec.lastActor) : createdBy,
    proposal: {
      draft: proposalRaw.draft != null ? JSON.parse(JSON.stringify(proposalRaw.draft)) : {},
      assignments:
        proposalRaw.assignments && typeof proposalRaw.assignments === 'object'
          ? (JSON.parse(JSON.stringify(proposalRaw.assignments)) as AssignmentStore)
          : {},
    },
  };
}

export function normalizeScheduleReviewsState(raw: unknown): ScheduleReviewsState {
  const items: ScheduleReviewItem[] = [];
  if (raw && typeof raw === 'object' && Array.isArray((raw as ScheduleReviewsState).items)) {
    (raw as ScheduleReviewsState).items.forEach((it) => {
      const n = normalizeItem(it);
      if (n) items.push(n);
    });
  }
  items.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  return { v: 1, items: items.slice(0, 80) };
}

export function mergeScheduleReviewsStates(
  localState: ScheduleReviewsState | null,
  remoteState: ScheduleReviewsState | null
): ScheduleReviewsState {
  const byId: Record<string, ScheduleReviewItem> = {};
  const take = (it: ScheduleReviewItem) => {
    const prev = byId[it.id];
    if (
      !prev ||
      String(it.updatedAt || it.createdAt || '') >= String(prev.updatedAt || prev.createdAt || '')
    ) {
      byId[it.id] = it;
    }
  };
  (remoteState?.items || []).forEach(take);
  (localState?.items || []).forEach(take);
  return normalizeScheduleReviewsState({ v: 1, items: Object.values(byId) });
}

export function inboxReviewsForViewer(
  state: ScheduleReviewsState,
  restaurantId: string,
  role: string | null | undefined
): ScheduleReviewItem[] {
  const rid = String(restaurantId || '');
  const isAdmin = role === 'admin';
  const isManager = role === 'manager' || isAdmin;
  return (state.items || []).filter((it) => {
    if (it.restaurantId !== rid) return false;
    if (it.status === 'pending_admin') return isAdmin;
    if (it.status === 'pending_manager') return isManager && !isAdmin;
    return false;
  });
}

export function makeScheduleReviewItem(opts: {
  restaurantId: string;
  weekMondayIso: string;
  weekIndex: number;
  status: 'pending_admin' | 'pending_manager';
  actor: ScheduleReviewActor;
  draft: unknown;
  assignments: AssignmentStore;
}): ScheduleReviewItem {
  const now = new Date().toISOString();
  return {
    id: uuid(),
    restaurantId: opts.restaurantId,
    weekMondayIso: opts.weekMondayIso,
    weekIndexAtSend: opts.weekIndex,
    status: opts.status,
    createdAt: now,
    updatedAt: now,
    createdBy: opts.actor,
    lastActor: opts.actor,
    proposal: {
      draft: JSON.parse(JSON.stringify(opts.draft ?? {})),
      assignments: JSON.parse(JSON.stringify(opts.assignments || {})),
    },
  };
}

export async function fetchScheduleReviews(
  sb: SupabaseClient,
  teamStateId: string
): Promise<ScheduleReviewsState> {
  const res = await sb
    .from('team_state')
    .select('schedule_reviews')
    .eq('id', teamStateId)
    .maybeSingle();
  if (res.error) return { v: 1, items: [] };
  return normalizeScheduleReviewsState(res.data?.schedule_reviews);
}

export async function pushScheduleReviews(
  sb: SupabaseClient,
  teamStateId: string,
  state: ScheduleReviewsState
): Promise<{ ok: boolean; error?: string }> {
  const payload = normalizeScheduleReviewsState(state);
  const up = await sb
    .from('team_state')
    .update({ schedule_reviews: payload })
    .eq('id', teamStateId)
    .select('id');
  if (up.error) return { ok: false, error: up.error.message };
  return { ok: true };
}
