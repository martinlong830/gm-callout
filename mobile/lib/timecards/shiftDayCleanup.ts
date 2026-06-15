import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmployeeRow } from '../employees';
import { setEmployeeDayDishwasherTip } from './dishwasherTips';
import { deleteTimeClockEntries, loadWeekEntries } from './entriesApi';
import { entriesForShiftDayCleanup, type ShiftDayRow } from './engine';
import { removeOffScheduleDay } from './offScheduleShift';
import type { PayWeekBounds, TimeClockEntry } from './types';
import { setEmployeeDayLeave } from './weekExtras';

const DELETE_MISMATCH_MESSAGE =
  'Could not delete all punch records. Sign in as a manager and apply the latest Supabase migrations (time_clock_entries_delete_managers).';

export async function removeShiftDay(
  supabase: SupabaseClient,
  emp: EmployeeRow,
  shiftRow: ShiftDayRow,
  entries: TimeClockEntry[],
  bounds: PayWeekBounds,
  options?: { clearDishwasherTip?: boolean; extraEntryIds?: string[] }
): Promise<{ ok: true } | { ok: false; message: string }> {
  const loaded = await loadWeekEntries(supabase, bounds);
  const sourceEntries = loaded.ok ? loaded.entries : entries;
  const cleanupEntries = entriesForShiftDayCleanup(
    sourceEntries,
    emp.id,
    shiftRow,
    options?.extraEntryIds
  );
  const dayEntryIds = cleanupEntries.map((e) => e.id).filter(Boolean);
  if (dayEntryIds.length) {
    const removeRes = await deleteTimeClockEntries(supabase, dayEntryIds);
    if (!removeRes.ok) return removeRes;
    if (removeRes.deletedIds.length !== dayEntryIds.length) {
      return { ok: false, message: DELETE_MISMATCH_MESSAGE };
    }
  }
  await setEmployeeDayLeave(emp.id, shiftRow.iso, 0, 0, bounds);
  if (options?.clearDishwasherTip) {
    await setEmployeeDayDishwasherTip(emp.id, shiftRow.iso, 0, bounds);
  }
  removeOffScheduleDay(emp.id, shiftRow.iso);
  return { ok: true };
}
