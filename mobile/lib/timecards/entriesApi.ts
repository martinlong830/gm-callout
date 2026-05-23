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
    'id, employee_id, clock_in_at, clock_out_at, break_minutes, break_start_at, break_end_at, schedule_shift_id, edit_history, updated_at';
  const res = await sb
    .from('time_clock_entries')
    .select(fullSel)
    .gte('clock_in_at', bounds.start.toISOString())
    .lte('clock_in_at', bounds.end.toISOString())
    .order('clock_in_at', { ascending: true });

  let entries: TimeClockEntry[] = [];
  if (res.error && /break_start_at|break_end_at|break_minutes|schedule_shift_id|edit_history/i.test(res.error.message || '')) {
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
  editingId: string | null;
  priorEntry: TimeClockEntry | null;
};

export async function saveManagerPunch(
  sb: SupabaseClient,
  schema: TimecardSchema,
  input: SavePunchInput
): Promise<{ ok: true; entryId: string | null } | { ok: false; message: string }> {
  const {
    employeeId,
    shiftId,
    clockInIso,
    clockOutIso,
    breakStartIso,
    breakEndIso,
    breakMinutes,
    editingId,
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

  if (!editingId) {
    const insRow: Record<string, unknown> = {
      employee_id: employeeId,
      clock_in_at: clockInIso,
      clock_out_at: clockOutIso,
    };
    if (schema.breakMinutes) insRow.break_minutes = breakMinutes;
    if (schema.breakTimes) {
      insRow.break_start_at = breakStartIso;
      insRow.break_end_at = breakEndIso;
    }
    if (schema.scheduleShiftId) insRow.schedule_shift_id = shiftId;
    if (schema.editHistory) insRow.edit_history = hist;
    const ins = await sb.from('time_clock_entries').insert(insRow).select('id').maybeSingle();
    if (ins.error) return { ok: false, message: ins.error.message };
    return { ok: true, entryId: ins.data?.id ? String(ins.data.id) : null };
  }

  const rpcArgs: Record<string, unknown> = {
    p_entry_id: editingId,
    p_employee_id: employeeId,
    p_clock_in_at: clockInIso,
    p_clock_out_at: clockOutIso,
  };
  if (schema.breakMinutes) rpcArgs.p_break_minutes = breakMinutes;
  if (schema.breakTimes) {
    rpcArgs.p_break_start_at = breakStartIso;
    rpcArgs.p_break_end_at = breakEndIso;
  }
  if (schema.scheduleShiftId) rpcArgs.p_schedule_shift_id = shiftId;
  if (schema.editHistory) rpcArgs.p_edit_history = hist;

  const rpcRes = await sb.rpc('manager_save_time_clock_entry', rpcArgs);
  if (
    rpcRes.error &&
    /manager_save_time_clock_entry|schema cache|function/i.test(rpcRes.error.message || '')
  ) {
    const payload: Record<string, unknown> = {
      clock_in_at: clockInIso,
      clock_out_at: clockOutIso,
    };
    if (schema.breakMinutes) payload.break_minutes = breakMinutes;
    if (schema.breakTimes) {
      payload.break_start_at = breakStartIso;
      payload.break_end_at = breakEndIso;
    }
    if (schema.scheduleShiftId) payload.schedule_shift_id = shiftId;
    if (schema.editHistory) payload.edit_history = hist;
    const up = await sb.from('time_clock_entries').update(payload).eq('id', editingId).select('id');
    if (up.error) return { ok: false, message: up.error.message };
    return { ok: true, entryId: editingId };
  }
  if (rpcRes.error) return { ok: false, message: rpcRes.error.message };
  const data = rpcRes.data as { ok?: boolean; error?: string } | null;
  if (!data?.ok) {
    const err =
      data?.error === 'unknown_employee'
        ? 'Employee not found in cloud roster.'
        : data?.error || 'Save failed.';
    return { ok: false, message: String(err) };
  }
  return { ok: true, entryId: editingId };
}
