import type { SupabaseClient } from '@supabase/supabase-js';
import { applyAvailabilityWeekEntry } from './availabilityByWeek';
import { saveEmployeeRow } from './employeeSave';
import { employeeDisplayName, type EmployeeRow } from './employees';
import type { DraftGrid } from './schedule/types';
import { updateStaffRequestStatus, type StaffRequestUi } from './staffRequests';
import { normalizeWeeklyGrid } from './weeklyAvailabilityMatrix';

function findEmployeeForRequest(employees: EmployeeRow[], request: StaffRequestUi): EmployeeRow | null {
  const target = String(request.employeeName || '')
    .trim()
    .toLowerCase();
  if (!target) return null;
  return (
    employees.find((e) => employeeDisplayName(e).trim().toLowerCase() === target) ??
    employees.find((e) => {
      const dn = String(e.displayName || '').trim().toLowerCase();
      const fl = `${e.firstName} ${e.lastName}`.trim().toLowerCase();
      return dn === target || fl === target;
    }) ??
    null
  );
}

/** Approve a request and run side effects (e.g. merge availability grid into roster). */
export async function approveStaffRequest(
  sb: SupabaseClient,
  request: StaffRequestUi,
  employees: EmployeeRow[],
  draftRows: DraftGrid
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (request.type === 'availability' && request.submittedGrid) {
    const emp = findEmployeeForRequest(employees, request);
    if (emp) {
      const staffType = emp.staffType || request.role || 'Kitchen';
      const merged = normalizeWeeklyGrid(request.submittedGrid, staffType, draftRows);
      const weekIndex =
        request.submittedWeekIndex != null ? Number(request.submittedWeekIndex) : 0;
      const withWeek = applyAvailabilityWeekEntry(
        emp,
        weekIndex,
        {
          grid: merged,
          status: 'approved',
          submittedAt: request.submittedAt || null,
        },
        { syncWeeklyGrid: true, draftRows }
      );
      const saved = await saveEmployeeRow(sb, withWeek);
      if (!saved.ok) {
        return {
          ok: false,
          message: saved.message || 'Could not update employee availability.',
        };
      }
    }
  }

  return updateStaffRequestStatus(sb, request.id, 'approved');
}
