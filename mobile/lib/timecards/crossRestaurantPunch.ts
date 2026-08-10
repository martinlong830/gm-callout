import type { EmployeeRow } from '../employees';
import { isCloudEmployeeId } from '../employees';
import { saveEmployeeRow } from '../employeeSave';
import { isSupabaseConfigured, supabase } from '../supabase';
import { isoFromDate } from './payWeek';
import type { PayWeekBounds } from './types';
import type { TimeClockEntry } from './types';
import { addOffScheduleDay, entryHasMeaningfulPunch } from './offScheduleShift';
import {
  employeeEligibleForWeekBorrow,
  setEmployeeBorrowedRestaurant,
  type BorrowRestaurantId,
} from './weekBorrow';
import { employeeHomeRestaurant } from './restaurantAttribution';

function punchDayIsoLocal(entry: TimeClockEntry): string {
  if (!entry?.clock_in_at) return '';
  return isoFromDate(new Date(entry.clock_in_at));
}

/** Other-store punch no longer permanently flips Team to both (use week borrow instead). */
export function shouldExpandEmployeeRestaurantForPunch(
  _emp: EmployeeRow,
  restaurantId: string | null | undefined
): boolean {
  if (!restaurantId || (restaurantId !== 'rp-8' && restaurantId !== 'rp-9')) return false;
  return false;
}

export function expandEmployeeRestaurantForPunchLocal(
  _emp: EmployeeRow,
  _restaurantId: string
): boolean {
  return false;
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

export async function applyCrossRestaurantPunchSideEffects(
  entries: TimeClockEntry[],
  employees: EmployeeRow[],
  bounds: PayWeekBounds,
  onEmployeeExpanded?: (emp: EmployeeRow) => void
): Promise<void> {
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
    if (employeeEligibleForWeekBorrow(emp)) {
      const home = employeeHomeRestaurant(emp);
      if (home !== rest) {
        await setEmployeeBorrowedRestaurant(emp.id, bounds, rest as BorrowRestaurantId);
      }
    }
    const iso = punchDayIsoLocal(entry);
    if (iso && entryHasMeaningfulPunch(entry, iso)) {
      addOffScheduleDay(entry.employee_id, iso);
    }
  }
}
