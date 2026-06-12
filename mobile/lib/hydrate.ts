import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAM_STATE_ROW_ID } from './constants';
import { applyLeaveSeedsToEmployees } from './employeeLeave';
import { mapEmployeeFromDb, type EmployeeRow } from './employees';
import { mapStaffRequestFromDbRow, type StaffRequestUi } from './staffRequests';

export type HydrationResult = {
  employees: EmployeeRow[];
  staffRequests: StaffRequestUi[];
  teamState: Record<string, unknown> | null;
};

const EMPLOYEE_LIST_COLUMNS =
  'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta';

export async function hydrateFromSupabase(
  sb: SupabaseClient,
  opts?: { role?: 'manager' | 'employee' | null; userId?: string | null }
): Promise<HydrationResult> {
  const empQuery =
    opts?.role === 'employee'
      ? sb.from('employees').select(EMPLOYEE_LIST_COLUMNS)
      : sb.from('employees').select('*');
  const [empRes, reqRes, teamRes] = await Promise.all([
    empQuery.order('display_name', { ascending: true }),
    sb.from('staff_requests').select('*').order('created_at', { ascending: false }),
    sb.from('team_state').select('*').eq('id', TEAM_STATE_ROW_ID).maybeSingle(),
  ]);

  const employees: EmployeeRow[] = [];
  if (empRes.data?.length) {
    for (const row of empRes.data) {
      const m = mapEmployeeFromDb(row as Record<string, unknown>);
      if (m) employees.push(m);
    }
  }

  if (opts?.role === 'employee' && opts.userId) {
    const selfRes = await sb
      .from('employees')
      .select('id, weekly_grid')
      .eq('auth_user_id', opts.userId)
      .maybeSingle();
    if (selfRes.data?.id) {
      const idx = employees.findIndex((e) => e.id === selfRes.data!.id);
      if (idx >= 0) {
        employees[idx] = {
          ...employees[idx],
          weeklyGrid: (selfRes.data.weekly_grid as Record<string, unknown>) ?? {},
        };
      }
    }
  }

  const staffRequests: StaffRequestUi[] = [];
  if (reqRes.data?.length) {
    for (const row of reqRes.data) {
      const m = mapStaffRequestFromDbRow(
        row as {
          id: string;
          type: string;
          status: string;
          created_at?: string;
          payload?: Record<string, unknown>;
        }
      );
      if (m) staffRequests.push(m);
    }
  }

  applyLeaveSeedsToEmployees(employees);

  const teamState =
    teamRes.data && typeof teamRes.data === 'object'
      ? (teamRes.data as Record<string, unknown>)
      : null;

  return { employees, staffRequests, teamState };
}
