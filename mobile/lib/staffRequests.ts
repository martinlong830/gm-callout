import type { SupabaseClient } from '@supabase/supabase-js';

export type StaffRequestUi = {
  id: string;
  type: string;
  employeeName: string;
  role: string;
  summary: string;
  submittedAt: string;
  status: string;
  offeredShiftLabel?: string;
  swapOfferId?: string;
  submittedGrid?: unknown;
  submittedWeekLabel?: string;
  submittedWeekIndex?: number;
};

function staffRequestStatusFromDb(st: string): string {
  if (st === 'rejected') return 'declined';
  if (st === 'closed') return 'approved';
  if (st === 'pending' || st === 'approved' || st === 'declined') return st;
  return 'pending';
}

export function mapStaffRequestFromDbRow(row: {
  id: string;
  type: string;
  status: string;
  created_at?: string;
  payload?: Record<string, unknown>;
}): StaffRequestUi | null {
  if (!row?.id) return null;
  const p = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const dbType = row.type;
  const uiType =
    (p.uiType as string) || (dbType === 'callout' ? 'callout_request' : dbType);
  const created = row.created_at ? String(row.created_at).slice(0, 10) : '';
  const full: StaffRequestUi = {
    id: row.id,
    type: uiType,
    employeeName: (p.employeeName as string) ?? '',
    role: (p.role as string) ?? 'Kitchen',
    summary: (p.summary as string) ?? '',
    submittedAt: (p.submittedAt as string) ?? created,
    status: staffRequestStatusFromDb(row.status),
  };
  if (p.offeredShiftLabel) full.offeredShiftLabel = p.offeredShiftLabel as string;
  if (p.swapOfferId) full.swapOfferId = p.swapOfferId as string;
  if (p.submittedGrid != null) full.submittedGrid = p.submittedGrid;
  if (p.submittedWeekLabel) full.submittedWeekLabel = p.submittedWeekLabel as string;
  if (p.submittedWeekIndex != null) full.submittedWeekIndex = Number(p.submittedWeekIndex);
  return full;
}

export function formatStaffRequestSubmittedDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function staffRequestStatusToDb(ux: 'approved' | 'declined'): 'approved' | 'rejected' {
  if (ux === 'declined') return 'rejected';
  return 'approved';
}

/** Same as web `isUuidCloudId` — only real Supabase rows get remote status updates. */
export function isCloudStaffRequestId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || '')
  );
}

export async function updateStaffRequestStatus(
  sb: SupabaseClient,
  id: string,
  ux: 'approved' | 'declined'
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isCloudStaffRequestId(id)) return { ok: false, message: 'Invalid request id.' };
  const dbSt = staffRequestStatusToDb(ux);
  const res = await sb.from('staff_requests').update({ status: dbSt }).eq('id', id);
  if (res.error) return { ok: false, message: res.error.message };
  return { ok: true };
}

/** True if submitted grid has any checked availability slot (Mon–Sun / slot keys). */
export function submittedAvailabilityGridIsNonEmpty(grid: unknown): boolean {
  if (!grid || typeof grid !== 'object') return false;
  const g = grid as Record<string, Record<string, unknown>>;
  for (const slots of Object.values(g)) {
    if (!slots || typeof slots !== 'object') continue;
    for (const v of Object.values(slots)) {
      if (v === true || v === 'true' || v === 1) return true;
    }
  }
  return false;
}

/** Readable summary of employee-submitted availability grid (weekday → slot keys). */
export function formatAvailabilityGridSummary(grid: unknown): string {
  if (!grid || typeof grid !== 'object') return 'No grid submitted.';
  const g = grid as Record<string, Record<string, boolean>>;
  const lines: string[] = [];
  for (const [day, slots] of Object.entries(g)) {
    if (!slots || typeof slots !== 'object') continue;
    const on = Object.entries(slots)
      .filter(([, v]) => !!v)
      .map(([k]) => k);
    lines.push(`${day}: ${on.length ? on.join(', ') : '—'}`);
  }
  return lines.length ? lines.join('\n') : 'No grid submitted.';
}

function staffRequestDbTypeFromUi(t: string): string | null {
  if (t === 'callout_request') return 'callout';
  if (t === 'availability' || t === 'timeoff' || t === 'swap' || t === 'callout') return t;
  return null;
}

export type NewStaffRequestInput = {
  type: string;
  employeeName: string;
  role: string;
  summary: string;
  submittedAt?: string;
  submittedGrid?: unknown;
  submittedWeekLabel?: string;
  submittedWeekIndex?: number;
  offeredShiftLabel?: string;
  swapOfferId?: string;
};

export async function insertStaffRequest(
  sb: SupabaseClient,
  full: NewStaffRequestInput
): Promise<{ ok: true; id: string } | { ok: false; message: string }> {
  const { data: sess } = await sb.auth.getSession();
  if (!sess?.session?.user?.id) return { ok: false, message: 'Not signed in.' };
  const dbType = staffRequestDbTypeFromUi(full.type);
  if (!dbType) return { ok: false, message: 'Invalid request type.' };
  const payload: Record<string, unknown> = {
    employeeName: full.employeeName,
    role: full.role,
    summary: full.summary,
    submittedAt: full.submittedAt ?? new Date().toISOString().slice(0, 10),
    uiType: full.type,
  };
  if (full.submittedGrid != null) payload.submittedGrid = full.submittedGrid;
  if (full.submittedWeekLabel) payload.submittedWeekLabel = full.submittedWeekLabel;
  if (full.submittedWeekIndex != null) payload.submittedWeekIndex = full.submittedWeekIndex;
  if (full.offeredShiftLabel) payload.offeredShiftLabel = full.offeredShiftLabel;
  if (full.swapOfferId) payload.swapOfferId = full.swapOfferId;

  const ins = await sb
    .from('staff_requests')
    .insert({
      requester_id: sess.session.user.id,
      type: dbType,
      status: 'pending',
      payload,
    })
    .select('id')
    .maybeSingle();

  if (ins.error) return { ok: false, message: ins.error.message };
  if (!ins.data?.id) return { ok: false, message: 'Insert returned no id.' };
  return { ok: true, id: ins.data.id };
}
