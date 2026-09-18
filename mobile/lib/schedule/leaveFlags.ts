import type { EmployeeRow } from '../employees';
import { employeeDisplayName } from '../employees';
import type { StaffRequestUi } from '../staffRequests';
import { buildScheduledMinutesByDayForEmployee } from '../timecards/engine';
import type { PayWeekBounds } from '../timecards/types';
import { getEffectiveDayLeaveSync, type WeekExtrasSlice } from '../timecards/weekExtras';
import type { EmployeeLite, WeekMeta } from './types';

function personDayKey(workerName: string, dayStr: string): string {
  return `${String(workerName || '')
    .trim()
    .toLowerCase()}\0${dayStr}`;
}

function formatLeaveHoursShort(n: number): string {
  const x = Math.max(0, Math.round((Number(n) || 0) * 100) / 100);
  if (Math.abs(x - Math.round(x)) < 0.005) return String(Math.round(x));
  return String(x);
}

/** Compact VL/SL flag copy — matches web `calendarLeaveFlagForPersonDay`. */
export function formatCalendarLeaveFlagText(vl: number, sl: number): string {
  const parts: string[] = [];
  if (vl > 0) parts.push(`VL ${formatLeaveHoursShort(vl)}h`);
  if (sl > 0) parts.push(`SL ${formatLeaveHoursShort(sl)}h`);
  return parts.join(' · ');
}

/** Person+day → `VL 8h` / `SL 4h` for the visible schedule week. */
export function buildCalendarLeaveFlagMap(params: {
  visibleDays: string[];
  weekMeta: WeekMeta[];
  employees: EmployeeRow[];
  employeesLite: EmployeeLite[];
  extrasSlice: WeekExtrasSlice;
  staffRequests: StaffRequestUi[];
  bounds: PayWeekBounds;
  teamState: Record<string, unknown> | null;
}): Map<string, string> {
  const out = new Map<string, string>();
  const {
    visibleDays,
    weekMeta,
    employees,
    employeesLite,
    extrasSlice,
    staffRequests,
    bounds,
    teamState,
  } = params;
  if (!visibleDays.length || !employees.length) return out;

  for (const emp of employees) {
    const name = employeeDisplayName(emp);
    if (!name) continue;
    const schedMinsByDay = buildScheduledMinutesByDayForEmployee(
      emp,
      teamState,
      employeesLite,
      bounds
    );
    for (const dayStr of visibleDays) {
      const iso = String(weekMeta.find((m) => m.label === dayStr)?.iso || '').slice(0, 10);
      if (!iso) continue;
      const leave = getEffectiveDayLeaveSync(
        emp,
        name,
        iso,
        bounds,
        staffRequests || [],
        schedMinsByDay,
        extrasSlice
      );
      const text = formatCalendarLeaveFlagText(leave.vl, leave.sl);
      if (!text) continue;
      out.set(personDayKey(name, dayStr), text);
      const aliases = emp.meta?.scheduleAliases;
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          if (alias && String(alias).trim()) {
            out.set(personDayKey(String(alias), dayStr), text);
          }
        }
      }
    }
  }
  return out;
}
