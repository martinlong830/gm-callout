import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { applyLeaveSeedsToEmployees } from './employeeLeave';
import { mapEmployeeFromDb, type EmployeeRow } from './employees';
import { mapStaffRequestFromDbRow, type StaffRequestUi } from './staffRequests';
import {
  TEAM_STATE_EMPLOYEE_COLUMNS,
  TEAM_STATE_MANAGER_COLUMNS,
} from './teamStateColumns';

export type HydrationResult = {
  employees: EmployeeRow[];
  staffRequests: StaffRequestUi[];
  teamState: Record<string, unknown> | null;
};

/** Roster columns — omit unused wide fields; managers still need weekly_grid for schedule. */
export const EMPLOYEE_LIST_COLUMNS =
  'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta';

export const EMPLOYEE_MANAGER_COLUMNS =
  'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';

export const STAFF_REQUEST_COLUMNS = 'id, type, status, created_at, payload';

export async function hydrateFromSupabase(
  sb: SupabaseClient,
  opts?: { role?: 'manager' | 'employee' | null; userId?: string | null }
): Promise<HydrationResult> {
  const teamStateId = await readStoredTeamStateId();
  const isManager = opts?.role === 'manager';
  const teamCols = isManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;

  const empQuery = isManager
    ? sb.from('employees').select(EMPLOYEE_MANAGER_COLUMNS)
    : sb.from('employees').select(EMPLOYEE_LIST_COLUMNS);

  const [empRes, reqRes, teamRes] = await Promise.all([
    empQuery.order('display_name', { ascending: true }),
    sb.from('staff_requests').select(STAFF_REQUEST_COLUMNS).order('created_at', { ascending: false }),
    sb.from('team_state').select(teamCols).eq('id', teamStateId).maybeSingle(),
  ]);

  const employees: EmployeeRow[] = [];
  if (empRes.data?.length) {
    for (const row of empRes.data) {
      const m = mapEmployeeFromDb(row as unknown as Record<string, unknown>);
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

export async function fetchEmployeesOnly(
  sb: SupabaseClient,
  opts?: { role?: 'manager' | 'employee' | null; userId?: string | null }
): Promise<EmployeeRow[]> {
  const isManager = opts?.role === 'manager';
  const empQuery = isManager
    ? sb.from('employees').select(EMPLOYEE_MANAGER_COLUMNS)
    : sb.from('employees').select(EMPLOYEE_LIST_COLUMNS);
  const empRes = await empQuery.order('display_name', { ascending: true });
  const employees: EmployeeRow[] = [];
  if (empRes.data?.length) {
    for (const row of empRes.data) {
      const m = mapEmployeeFromDb(row as unknown as Record<string, unknown>);
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
  applyLeaveSeedsToEmployees(employees);
  return employees;
}

export async function fetchStaffRequestsOnly(sb: SupabaseClient): Promise<StaffRequestUi[]> {
  const reqRes = await sb
    .from('staff_requests')
    .select(STAFF_REQUEST_COLUMNS)
    .order('created_at', { ascending: false });
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
  return staffRequests;
}
