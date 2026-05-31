import type { SupabaseClient } from '@supabase/supabase-js';
import { getPayWeekBounds } from './payWeek';
import type { TimecardSchema, TimeClockEntry } from './types';

function mergeWeekEntriesById(primary: TimeClockEntry[], extra: TimeClockEntry[]): TimeClockEntry[] {
  const byId: Record<string, TimeClockEntry> = {};
  for (const e of primary) {
    if (e?.id) byId[e.id] = e;
  }
  for (const e of extra) {
    if (e?.id && !byId[e.id]) byId[e.id] = e;
  }
  return Object.values(byId).sort((a, b) => String(a.clock_in_at).localeCompare(String(b.clock_in_at)));
}

export async function loadWeekEntries(sb: SupabaseClient): Promise<{
  ok: true;
  entries: TimeClockEntry[];
  schema: TimecardSchema;
} | { ok: false; reason: string }> {
  const bounds = getPayWeekBounds();
  const fullSel =
    'id, employee_id, clock_in_at, clock_out_at, break_minutes, break_start_at, break_end_at, break_segments, break_paid, schedule_shift_id, edit_history, updated_at';
  const res = await sb
    .from('time_clock_entries')
    .select(fullSel)
    .gte('clock_in_at', bounds.start.toISOString())
    .lte('clock_in_at', bounds.end.toISOString())
    .order('clock_in_at', { ascending: true });

  let entries: TimeClockEntry[] = [];
  if (res.error && /break_start_at|break_end_at|break_minutes|break_segments|break_paid|schedule_shift_id|edit_history/i.test(res.error.message || '')) {
    const fallback = await sb
      .from('time_clock_entries')
      .select('id, employee_id, clock_in_at, clock_out_at, updated_at')
      .gte('clock_in_at', bounds.start.toISOString())
      .lte('clock_in_at', bounds.end.toISOString())
      .order('clock_in_at', { ascending: true });
    if (fallback.error) return { ok: false, reason: fallback.error.message };
    entries = (fallback.data || []) as unknown as TimeClockEntry[];
  } else {
    if (res.error) return { ok: false, reason: res.error.message };
    entries = (res.data || []) as unknown as TimeClockEntry[];
  }
  const schema: TimecardSchema = {
    breakMinutes: !!(entries.length && entries[0].break_minutes !== undefined),
    breakTimes: !!(entries.length && entries[0].break_start_at !== undefined),
    scheduleShiftId: !!(entries.length && entries[0].schedule_shift_id !== undefined),
    editHistory: !!(entries.length && entries[0].edit_history !== undefined),
    breakPaid: !!(entries.length && entries[0].break_paid !== undefined),
  };

  const openSel = schema.breakMinutes
    ? fullSel
    : 'id, employee_id, clock_in_at, clock_out_at, updated_at';
  const openRes = await sb
    .from('time_clock_entries')
    .select(openSel)
    .is('clock_out_at', null)
    .lt('clock_in_at', bounds.end.toISOString());

  if (!openRes.error && openRes.data?.length) {
    entries = mergeWeekEntriesById(entries, openRes.data as unknown as TimeClockEntry[]);
  }

  return { ok: true, entries, schema };
}

export type SavePunchInput = {
  employeeId: string;
  shiftId: string;
  clockInIso: string;
  clockOutIso: string | null;
  breakStartIso: string | null;
  breakEndIso: string | null;
  breakMinutes: number;
  breakPaid?: boolean | null;
  editingId: string | null;
  priorEntry: TimeClockEntry | null;
};

function managerSaveErrorMessage(rpcRes: {
  error?: { message?: string } | null;
  data?: { ok?: boolean; error?: string } | null;
}): string {
  const msg = rpcRes.error?.message || '';
  if (/row-level security|violates row-level security/i.test(msg)) {
    return 'Save blocked by database permissions. Sign in as a manager and apply the latest Supabase migrations.';
  }
  if (rpcRes.data?.error === 'unknown_employee') {
    return 'Employee not found in cloud roster.';
  }
  if (rpcRes.data?.error) return String(rpcRes.data.error);
  return msg || 'Save failed.';
}

async function callManagerSaveRpc(
  sb: SupabaseClient,
  schema: TimecardSchema,
  input: SavePunchInput,
  editHistory: unknown[]
) {
  const {
    employeeId,
    shiftId,
    clockInIso,
    clockOutIso,
    breakStartIso,
    breakEndIso,
    breakMinutes,
    breakPaid,
    editingId,
  } = input;

  const base: Record<string, unknown> = {
    p_entry_id: editingId || null,
    p_employee_id: employeeId,
    p_clock_in_at: clockInIso,
    p_clock_out_at: clockOutIso,
  };
  const fullArgs = { ...base };
  if (schema.breakMinutes) fullArgs.p_break_minutes = breakMinutes;
  if (schema.breakTimes) {
    fullArgs.p_break_start_at = breakStartIso;
    fullArgs.p_break_end_at = breakEndIso;
  }
  if (schema.scheduleShiftId) fullArgs.p_schedule_shift_id = shiftId;
  if (schema.editHistory) fullArgs.p_edit_history = editHistory;
  if (schema.breakPaid && breakPaid !== undefined) fullArgs.p_break_paid = breakPaid;

  let res = await sb.rpc('manager_save_time_clock_entry', fullArgs);
  if (res.error) {
    const msg = res.error.message || '';
    if (/42883|function|schema cache|Could not find|break_start|argument/i.test(msg)) {
      res = await sb.rpc('manager_save_time_clock_entry', {
        ...base,
        p_break_minutes: breakMinutes,
        p_schedule_shift_id: shiftId,
        p_edit_history: editHistory,
      });
    }
  }
  return res;
}

export async function saveManagerPunch(
  sb: SupabaseClient,
  schema: TimecardSchema,
  input: SavePunchInput
): Promise<{ ok: true; entryId: string | null } | { ok: false; message: string }> {
  const {
    clockInIso,
    clockOutIso,
    breakStartIso,
    breakEndIso,
    breakMinutes,
    priorEntry,
  } = input;
  const hist: unknown[] = [];
  if (priorEntry && Array.isArray(priorEntry.edit_history)) {
    hist.push(...priorEntry.edit_history);
  }
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (priorEntry) {
    if (priorEntry.clock_in_at !== clockInIso) {
      changes.clock_in_at = { from: priorEntry.clock_in_at, to: clockInIso };
    }
    const prevOut = priorEntry.clock_out_at || null;
    if (prevOut !== clockOutIso) {
      changes.clock_out_at = { from: prevOut, to: clockOutIso };
    }
    if (Number(priorEntry.break_minutes || 0) !== breakMinutes) {
      changes.break_minutes = { from: priorEntry.break_minutes, to: breakMinutes };
    }
    const prevBreakStart = priorEntry.break_start_at || null;
    if (prevBreakStart !== breakStartIso) {
      changes.break_start_at = { from: prevBreakStart, to: breakStartIso };
    }
    const prevBreakEnd = priorEntry.break_end_at || null;
    if (prevBreakEnd !== breakEndIso) {
      changes.break_end_at = { from: prevBreakEnd, to: breakEndIso };
    }
  }
  if (Object.keys(changes).length) {
    hist.push({ at: new Date().toISOString(), by: 'manager', changes });
  }

  const rpcRes = await callManagerSaveRpc(sb, schema, input, hist);
  if (rpcRes.error) {
    return { ok: false, message: managerSaveErrorMessage(rpcRes) };
  }
  const data = rpcRes.data as { ok?: boolean; error?: string; id?: string } | null;
  if (!data?.ok) {
    return { ok: false, message: managerSaveErrorMessage(rpcRes) };
  }
  return { ok: true, entryId: data.id ? String(data.id) : input.editingId };
}
