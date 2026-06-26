import type { EmployeeRow } from '../employees';
import { isCloudEmployeeId } from '../employees';
import { saveEmployeeRow } from '../employeeSave';
import { isSupabaseConfigured, supabase } from '../supabase';
import { isoFromDate } from './payWeek';
import type { TimeClockEntry } from './types';
import { addOffScheduleDay, entryHasMeaningfulPunch } from './offScheduleShift';

function punchDayIsoLocal(entry: TimeClockEntry): string {
  if (!entry?.clock_in_at) return '';
  return isoFromDate(new Date(entry.clock_in_at));
}

/** Widen team location when punches land at an unassigned store. */
export function shouldExpandEmployeeRestaurantForPunch(
  emp: EmployeeRow,
  restaurantId: string | null | undefined
): boolean {
  if (!restaurantId || (restaurantId !== 'rp-8' && restaurantId !== 'rp-9')) return false;
  const home = emp.usualRestaurant || 'rp-9';
  return home !== 'both' && home !== restaurantId;
}

export function expandEmployeeRestaurantForPunchLocal(emp: EmployeeRow, restaurantId: string): boolean {
  if (!shouldExpandEmployeeRestaurantForPunch(emp, restaurantId)) return false;
  emp.usualRestaurant = 'both';
  return true;
}

export async function persistExpandedEmployeeRestaurant(
  emp: EmployeeRow,
  restaurantId: string
): Promise<boolean> {
  if (!expandEmployeeRestaurantForPunchLocal(emp, restaurantId)) return false;
  if (!isCloudEmployeeId(emp.id)) return true;
  if (!isSupabaseConfigured || !supabase) return false;
  const res = await saveEmployeeRow(supabase, emp);
  return res.ok;
}

export function applyCrossRestaurantPunchSideEffects(
  entries: TimeClockEntry[],
  employees: EmployeeRow[],
  onEmployeeExpanded?: (emp: EmployeeRow) => void
): void {
  const byId = new Map(employees.map((e) => [e.id, e]));
  for (const entry of entries) {
    if (!entry.employee_id || !entry.clock_in_at) continue;
    const rest = entry.clock_restaurant_id;
    if (rest !== 'rp-8' && rest !== 'rp-9') continue;
    const emp = byId.get(entry.employee_id);
    if (!emp) continue;
    if (expandEmployeeRestaurantForPunchLocal(emp, rest) && onEmployeeExpanded) {
      onEmployeeExpanded(emp);
    }
    const iso = punchDayIsoLocal(entry);
    if (iso && entryHasMeaningfulPunch(entry, iso)) {
      addOffScheduleDay(entry.employee_id, iso);
    }
  }
}
