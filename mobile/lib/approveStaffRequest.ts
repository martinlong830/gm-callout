import type { SupabaseClient } from '@supabase/supabase-js';
import { applyAvailabilityWeekEntry } from './availabilityByWeek';
import { saveEmployeeRow } from './employeeSave';
import { employeeDisplayName, type EmployeeRow } from './employees';
import {
  applyCalloutApprovalEffects,
  applyTimeoffApprovalEffects,
} from './leaveApprovalEffects';
import type { AssignmentStore, DraftGrid } from './schedule/types';
import { approveSwapAcceptance, swapRequestCanManagerApprove } from './shiftSwap';
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

function isCalloutRequest(request: StaffRequestUi): boolean {
  return request.type === 'callout_request' || request.type === 'callout';
}

export type ApproveStaffRequestResult =
  | { ok: true; store?: AssignmentStore }
  | { ok: false; message: string };

/** Approve a request and run side effects (availability, swap, timeoff/callout schedule + leave). */
export async function approveStaffRequest(
  sb: SupabaseClient,
  request: StaffRequestUi,
  employees: EmployeeRow[],
  draftRows: DraftGrid,
  opts?: {
    allRequests?: StaffRequestUi[];
    assignmentStore?: AssignmentStore | null;
    draftScheduleRaw?: unknown;
  }
): Promise<ApproveStaffRequestResult> {
  if (request.type === 'swap') {
    if (!swapRequestCanManagerApprove(request)) {
      return {
        ok: false,
        message: 'A cover worker must accept this swap before you can approve it.',
      };
    }
    return approveSwapAcceptance(
      sb,
      request,
      opts?.allRequests || [],
      opts?.assignmentStore
    );
  }

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

  const scheduleOpts = {
    assignmentStore: (opts?.assignmentStore || {}) as AssignmentStore,
    draftRows,
    draftScheduleRaw: opts?.draftScheduleRaw,
    employees,
  };

  if (request.type === 'timeoff') {
    const emp = findEmployeeForRequest(employees, request);
    if (!emp) {
      return { ok: false, message: 'Could not find the employee for this time-off request.' };
    }
    const effects = await applyTimeoffApprovalEffects(sb, request, emp, scheduleOpts);
    if (!effects.ok) return effects;
    const statusRes = await updateStaffRequestStatus(sb, request.id, 'approved');
    if (!statusRes.ok) return statusRes;
    return { ok: true, store: effects.store };
  }

  if (isCalloutRequest(request)) {
    const emp = findEmployeeForRequest(employees, request);
    const effects = await applyCalloutApprovalEffects(sb, request, emp, scheduleOpts);
    if (!effects.ok) return effects;
    const statusRes = await updateStaffRequestStatus(sb, request.id, 'approved');
    if (!statusRes.ok) return statusRes;
    return { ok: true, store: effects.store };
  }

  return updateStaffRequestStatus(sb, request.id, 'approved');
}
