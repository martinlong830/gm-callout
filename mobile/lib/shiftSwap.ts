import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { employeeDisplayName, type EmployeeRow } from './employees';
import {
  addDraftSlotRow,
  buildWeeksFromMonday,
  getScheduleAnchorMondayDate,
  loadDraftFromTeamState,
  lookupScheduleAssignment,
  normalizeScheduleAssignment,
  parseRedPokeTimeLabel,
  parseShiftIdParts,
  patchDraftScheduleForWeek,
  redPokeBreakAnnotation,
  redPokeShiftHoursDecimal,
  redPokeShiftTimeLabel,
  ROLE_DEFS,
  SCHEDULE_VIEW_WEEK_COUNT,
} from './schedule/engine';
import { hashScheduleBundle } from './schedule/scheduleRevisions';
import { patchSlotOrderAfterAdd } from './schedule/slotOrder';
import type { AssignmentStore, DraftGrid, RoleKey } from './schedule/types';
import { broadcastTeamStateChanged } from './teamStateSync';
import {
  isCloudStaffRequestId,
  type OfferedShiftRef,
  type StaffRequestUi,
  updateStaffRequestStatus,
} from './staffRequests';

function asRoleKey(raw: string | null | undefined): RoleKey | null {
  if (raw === 'Kitchen' || raw === 'Bartender' || raw === 'Server') return raw;
  return null;
}

function normalizeWorkerKey(name: string): string {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeHHMM(val: unknown): string {
  const s = String(val || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return '';
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const mi = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`;
}

function makeNullDraftWeekRow(): Array<[string, string] | null> {
  return [null, null, null, null, null, null, null];
}

function ensureDraftRoleRow(draft: DraftGrid, role: RoleKey, trIdx: number) {
  if (!draft[role]) draft[role] = [];
  while (draft[role].length <= trIdx) {
    draft[role].push(makeNullDraftWeekRow());
  }
  if (!draft[role][trIdx]) {
    draft[role][trIdx] = makeNullDraftWeekRow();
  }
}

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
  if (request.swapOfferId) return 'pending_approval';
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

function canonicalCoverName(employees: EmployeeRow[] | undefined, cover: string): string {
  const key = normalizeWorkerKey(cover);
  if (!key) return cover;
  const hit = (employees || []).find(
    (e) => normalizeWorkerKey(employeeDisplayName(e)) === key
  );
  return hit ? employeeDisplayName(hit).trim() || cover : cover;
}

function coverHasPersonRow(
  store: AssignmentStore,
  restaurantId: string,
  role: RoleKey,
  weekIndex: number,
  coverName: string,
  draftRows: DraftGrid
): number {
  const roleIdx = ROLE_DEFS.findIndex((r) => r.role === role);
  if (roleIdx < 0) return -1;
  const key = normalizeWorkerKey(coverName);
  const rs = store[restaurantId] || {};
  const weekStart = weekIndex * 7;
  const n = (draftRows[role] || []).length;
  if (n <= 0) return -1;
  for (let tr = 0; tr < n; tr += 1) {
    for (let d = 0; d < 7; d += 1) {
      const sid = `shift-${weekStart + d}-${roleIdx}-${tr}`;
      const entry = lookupScheduleAssignment(rs, sid);
      if ((entry?.workers || []).some((w) => w && w !== 'Unassigned' && normalizeWorkerKey(w) === key)) {
        return tr;
      }
    }
  }
  return -1;
}

/**
 * Apply cover worker onto the offered shift. If they have no person row for their
 * role that week, add a draft slot line, move that day's times, and clear the original.
 */
export async function applyApprovedSwapToSchedule(
  sb: SupabaseClient,
  assignmentStore: AssignmentStore | null | undefined,
  offer: StaffRequestUi,
  coverWorkerName: string,
  opts?: {
    draftScheduleRaw?: unknown;
    acceptance?: StaffRequestUi;
    employees?: EmployeeRow[];
  }
): Promise<
  | {
      ok: true;
      store: AssignmentStore;
      draftSchedule?: unknown;
      updatedAt?: string;
      scheduleHash?: string;
    }
  | { ok: false; message: string }
> {
  const shift = resolveOfferedShift(offer);
  if (!shift) {
    return {
      ok: false,
      message:
        'This swap offer is missing shift details. Ask the employee to re-post the offer, then approve again.',
    };
  }
  const coverRaw = String(coverWorkerName || '').trim();
  if (!coverRaw) return { ok: false, message: 'Cover worker name is missing.' };
  const cover = canonicalCoverName(opts?.employees, coverRaw);

  const parts = parseShiftIdParts(shift.shiftId);
  if (!parts) return { ok: false, message: 'Offered shift id is invalid.' };
  const offeredRole = ROLE_DEFS[parts.roleIdx]?.role as RoleKey | undefined;
  if (!offeredRole) return { ok: false, message: 'Offered shift role is invalid.' };

  const wi = Math.floor(parts.globalDayIdx / 7);
  const dayInWeek = parts.globalDayIdx % 7;
  const rid = shift.restaurantId;

  const coverEmp =
    (opts?.employees || []).find(
      (e) => normalizeWorkerKey(employeeDisplayName(e)) === normalizeWorkerKey(cover)
    ) || null;
  const coverRole =
    asRoleKey(coverEmp?.staffType) ||
    asRoleKey(opts?.acceptance?.role) ||
    offeredRole;
  const coverRoleIdx = ROLE_DEFS.findIndex((r) => r.role === coverRole);
  if (coverRoleIdx < 0) return { ok: false, message: 'Cover worker role is invalid.' };

  let nextStore = JSON.parse(JSON.stringify(assignmentStore || {})) as AssignmentStore;
  if (!nextStore[rid]) nextStore[rid] = {};
  const rs = nextStore[rid];

  let draftRaw = opts?.draftScheduleRaw;
  let draftRows = loadDraftFromTeamState(draftRaw, wi, rid);
  if (!draftRows[coverRole]) draftRows[coverRole] = [];
  const existingTr = coverHasPersonRow(nextStore, rid, coverRole, wi, cover, draftRows);
  const origEntry = normalizeScheduleAssignment(rs[shift.shiftId]);

  const offeredCell = draftRows[offeredRole]?.[parts.trIdx]?.[dayInWeek] as
    | [string, string]
    | null
    | undefined;
  let start = offeredCell?.[0] ? normalizeHHMM(offeredCell[0]) : '';
  let end = offeredCell?.[1] ? normalizeHHMM(offeredCell[1]) : '';
  if (!start || !end) {
    const parsed = parseRedPokeTimeLabel(origEntry.timeLabel || shift.timeLabel || '');
    if (parsed) {
      start = parsed.start;
      end = parsed.end;
    }
  }
  const breakText =
    origEntry.break ||
    (start && end ? redPokeBreakAnnotation(start, end, offeredRole, shift.day || '') : '');
  const timeLabel =
    origEntry.timeLabel ||
    (start && end ? redPokeShiftTimeLabel(start, end) : shift.timeLabel || '');
  const hours =
    origEntry.hours != null
      ? origEntry.hours
      : start && end
        ? redPokeShiftHoursDecimal(start, end)
        : undefined;

  let draftChanged = false;

  const moveOntoCoverTr = (targetTr: number) => {
    ensureDraftRoleRow(draftRows, coverRole, targetTr);
    draftRows[coverRole][targetTr][dayInWeek] = [start, end];
    ensureDraftRoleRow(draftRows, offeredRole, parts.trIdx);
    draftRows[offeredRole][parts.trIdx][dayInWeek] = null;
    const coverSid = `shift-${parts.globalDayIdx}-${coverRoleIdx}-${targetTr}`;
    rs[coverSid] = {
      workers: [cover],
      break: breakText,
      timeLabel,
      hours,
    };
    rs[shift.shiftId] = { workers: ['Unassigned'] };
    draftChanged = true;
  };

  if (existingTr >= 0) {
    const coverDayCell = draftRows[coverRole]?.[existingTr]?.[dayInWeek] as
      | [string, string]
      | null
      | undefined;
    const coverDayHasTimes = !!(coverDayCell?.[0] && coverDayCell?.[1]);
    if ((!start || !end) && coverDayHasTimes) {
      /* Idempotent retry after a prior move. */
      const placedSid = `shift-${parts.globalDayIdx}-${coverRoleIdx}-${existingTr}`;
      const prior = normalizeScheduleAssignment(rs[placedSid]);
      rs[placedSid] = {
        workers: [cover],
        break: prior.break || breakText,
        timeLabel: prior.timeLabel || timeLabel,
        hours: prior.hours != null ? prior.hours : hours,
      };
      rs[shift.shiftId] = { workers: ['Unassigned'] };
    } else if (start && end && (coverRole !== offeredRole || !coverDayHasTimes)) {
      moveOntoCoverTr(existingTr);
    } else {
      nextStore = reassignShiftWorkerInStore(nextStore, rid, shift.shiftId, cover);
    }
  } else {
    if (!start || !end) {
      return {
        ok: false,
        message:
          'Could not read offered shift times to place the cover on a new schedule row.',
      };
    }
    const withRow = addDraftSlotRow(draftRows, coverRole);
    if (!withRow) {
      return { ok: false, message: 'Maximum of 25 slots per role — cannot add a cover row.' };
    }
    draftRows = withRow;
    const newTrIdx = (draftRows[coverRole] || []).length - 1;
    moveOntoCoverTr(newTrIdx);
    draftRaw = patchDraftScheduleForWeek(draftRaw, wi, rid, draftRows);
    const weekMeta = buildWeeksFromMonday(
      SCHEDULE_VIEW_WEEK_COUNT,
      getScheduleAnchorMondayDate()
    );
    const mondayIso = weekMeta[wi]?.iso || '';
    if (mondayIso) {
      draftRaw = patchSlotOrderAfterAdd(draftRaw, mondayIso, rid, coverRole, newTrIdx);
    }
    draftChanged = true;
  }

  if (draftChanged && existingTr >= 0) {
    draftRaw = patchDraftScheduleForWeek(draftRaw, wi, rid, draftRows);
  }

  const teamStateId = await readStoredTeamStateId();
  const payload: Record<string, unknown> = {
    id: teamStateId,
    schedule_assignments: nextStore,
  };
  if (draftRaw != null && draftChanged) {
    payload.draft_schedule = draftRaw;
  }
  const up = await sb
    .from('team_state')
    .upsert(payload, { onConflict: 'id' })
    .select('id, updated_at')
    .single();
  if (up.error) return { ok: false, message: up.error.message };

  const updatedAt = up.data?.updated_at != null ? String(up.data.updated_at) : undefined;
  const draftForHash = draftChanged
    ? draftRaw
    : opts?.draftScheduleRaw != null
      ? opts.draftScheduleRaw
      : {};
  const scheduleHash = hashScheduleBundle(nextStore, draftForHash);

  try {
    const cols = draftChanged
      ? (['schedule_assignments', 'draft_schedule'] as const)
      : (['schedule_assignments'] as const);
    await broadcastTeamStateChanged(sb, teamStateId, [...cols]);
  } catch {
    /* non-blocking */
  }

  return {
    ok: true,
    store: nextStore,
    draftSchedule: draftChanged ? draftRaw : undefined,
    updatedAt,
    scheduleHash,
  };
}

/**
 * Approve a swap acceptance: mutate schedule, approve acceptance + linked offer,
 * decline competing pending acceptances for the same offer.
 */
export async function approveSwapAcceptance(
  sb: SupabaseClient,
  acceptance: StaffRequestUi,
  allRequests: StaffRequestUi[],
  assignmentStore: AssignmentStore | null | undefined,
  opts?: {
    draftScheduleRaw?: unknown;
    employees?: EmployeeRow[];
  }
): Promise<
  | {
      ok: true;
      store?: AssignmentStore;
      draftSchedule?: unknown;
      updatedAt?: string;
      scheduleHash?: string;
    }
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
    acceptance.employeeName,
    {
      draftScheduleRaw: opts?.draftScheduleRaw,
      acceptance,
      employees: opts?.employees,
    }
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

  return {
    ok: true,
    store: scheduleRes.store,
    draftSchedule: scheduleRes.draftSchedule,
    updatedAt: scheduleRes.updatedAt,
    scheduleHash: scheduleRes.scheduleHash,
  };
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
