import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { employeeDisplayName, type EmployeeRow } from './employees';
import { normalizeScheduleAssignment } from './schedule/engine';
import type { AssignmentStore } from './schedule/types';
import { broadcastTeamStateChanged } from './teamStateSync';
import {
  isCloudStaffRequestId,
  type OfferedShiftRef,
  type StaffRequestUi,
  updateStaffRequestStatus,
} from './staffRequests';

/** Offer awaiting a cover worker — manager must not approve yet. */
export function isSwapOfferAwaitingCover(
  request: StaffRequestUi,
  all: StaffRequestUi[]
): boolean {
  if (request.type !== 'swap' || request.status !== 'pending') return false;
  if (request.swapOfferId) return false;
  return !all.some(
    (r) =>
      r.type === 'swap' &&
      r.status === 'pending' &&
      r.swapOfferId === request.id &&
      r.id !== request.id
  );
}

/** Manager may approve only after someone accepted (approval row has swapOfferId). */
export function swapRequestCanManagerApprove(request: StaffRequestUi): boolean {
  if (request.type !== 'swap') return request.status === 'pending';
  if (request.status !== 'pending') return false;
  return !!request.swapOfferId;
}

export function swapRequestDisplayStatus(
  request: StaffRequestUi,
  all: StaffRequestUi[]
): string {
  if (request.type !== 'swap' || request.status !== 'pending') return request.status;
  if (request.swapOfferId) return 'pending';
  if (isSwapOfferAwaitingCover(request, all)) return 'awaiting_cover';
  return 'pending';
}

export function offerVisibleToWorker(
  offer: StaffRequestUi,
  workerName: string,
  workerEmployeeId?: string | null
): boolean {
  const targetId = String(offer.swapTargetEmployeeId || '').trim();
  const targetName = String(offer.swapTargetEmployeeName || '').trim().toLowerCase();
  if (!targetId && !targetName) return true;
  if (targetId && workerEmployeeId && targetId === workerEmployeeId) return true;
  const self = String(workerName || '')
    .trim()
    .toLowerCase();
  if (targetName && self && targetName === self) return true;
  return false;
}

export function reassignShiftWorkerInStore(
  store: AssignmentStore,
  restaurantId: string,
  shiftId: string,
  newWorkerName: string
): AssignmentStore {
  const next = JSON.parse(JSON.stringify(store || {})) as AssignmentStore;
  if (!next[restaurantId]) next[restaurantId] = {};
  const existing = next[restaurantId][shiftId];
  const norm = normalizeScheduleAssignment(existing);
  next[restaurantId][shiftId] = {
    ...norm,
    workers: [String(newWorkerName || '').trim() || 'Unassigned'],
  };
  return next;
}

function resolveOfferedShift(offer: StaffRequestUi | null | undefined): OfferedShiftRef | null {
  if (!offer) return null;
  const s = offer.offeredShift;
  if (s && s.restaurantId && s.shiftId) {
    return {
      restaurantId: String(s.restaurantId),
      shiftId: String(s.shiftId),
      day: s.day != null ? String(s.day) : undefined,
      timeLabel: s.timeLabel != null ? String(s.timeLabel) : undefined,
      iso: s.iso != null ? String(s.iso) : undefined,
    };
  }
  return null;
}

/**
 * Apply cover worker onto the offered shift in schedule_assignments and persist team_state.
 */
export async function applyApprovedSwapToSchedule(
  sb: SupabaseClient,
  assignmentStore: AssignmentStore | null | undefined,
  offer: StaffRequestUi,
  coverWorkerName: string
): Promise<{ ok: true; store: AssignmentStore } | { ok: false; message: string }> {
  const shift = resolveOfferedShift(offer);
  if (!shift) {
    return {
      ok: false,
      message:
        'This swap offer is missing shift details. Ask the employee to re-post the offer, then approve again.',
    };
  }
  const cover = String(coverWorkerName || '').trim();
  if (!cover) return { ok: false, message: 'Cover worker name is missing.' };

  const nextStore = reassignShiftWorkerInStore(
    (assignmentStore || {}) as AssignmentStore,
    shift.restaurantId,
    shift.shiftId,
    cover
  );

  const teamStateId = await readStoredTeamStateId();
  const up = await sb.from('team_state').upsert(
    {
      id: teamStateId,
      schedule_assignments: nextStore,
    },
    { onConflict: 'id' }
  );
  if (up.error) return { ok: false, message: up.error.message };

  try {
    await broadcastTeamStateChanged(sb, teamStateId, ['schedule_assignments']);
  } catch {
    /* non-blocking */
  }

  return { ok: true, store: nextStore };
}

/**
 * Approve a swap acceptance: mutate schedule, approve acceptance + linked offer,
 * decline competing pending acceptances for the same offer.
 */
export async function approveSwapAcceptance(
  sb: SupabaseClient,
  acceptance: StaffRequestUi,
  allRequests: StaffRequestUi[],
  assignmentStore: AssignmentStore | null | undefined
): Promise<
  | { ok: true; store?: AssignmentStore }
  | { ok: false; message: string }
> {
  if (!swapRequestCanManagerApprove(acceptance)) {
    return {
      ok: false,
      message: 'A cover worker must accept this swap before you can approve it.',
    };
  }
  if (!isCloudStaffRequestId(acceptance.id)) {
    return { ok: false, message: 'Invalid request id.' };
  }

  const offer =
    allRequests.find((r) => r.id === acceptance.swapOfferId) ||
    (null as StaffRequestUi | null);

  if (!offer) {
    return { ok: false, message: 'Linked swap offer was not found.' };
  }

  const scheduleRes = await applyApprovedSwapToSchedule(
    sb,
    assignmentStore,
    offer,
    acceptance.employeeName
  );
  if (!scheduleRes.ok) return scheduleRes;

  const acceptRes = await updateStaffRequestStatus(sb, acceptance.id, 'approved');
  if (!acceptRes.ok) return acceptRes;

  if (isCloudStaffRequestId(offer.id) && offer.status === 'pending') {
    await updateStaffRequestStatus(sb, offer.id, 'approved');
  }

  const competitors = allRequests.filter(
    (r) =>
      r.type === 'swap' &&
      r.status === 'pending' &&
      r.swapOfferId === offer.id &&
      r.id !== acceptance.id &&
      isCloudStaffRequestId(r.id)
  );
  for (const c of competitors) {
    await updateStaffRequestStatus(sb, c.id, 'declined');
  }

  return { ok: true, store: scheduleRes.store };
}

export function coworkerSwapTargets(
  employees: EmployeeRow[],
  selfName: string,
  selfId?: string | null
): { id: string; name: string }[] {
  const selfKey = String(selfName || '')
    .trim()
    .toLowerCase();
  return employees
    .filter((e) => {
      if (selfId && e.id === selfId) return false;
      const name = employeeDisplayName(e).trim();
      if (!name) return false;
      if (selfKey && name.toLowerCase() === selfKey) return false;
      return true;
    })
    .map((e) => ({ id: e.id, name: employeeDisplayName(e).trim() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
