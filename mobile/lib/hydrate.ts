import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId, resolveCompanyIdForEmployees } from './companySession';
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
  'id, auth_user_id, first_name, last_name, display_name, phone, email, staff_type, usual_restaurant, hourly_rate, clock_pin, meta';

export const EMPLOYEE_MANAGER_COLUMNS =
  'id, auth_user_id, first_name, last_name, display_name, phone, email, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';

export const STAFF_REQUEST_COLUMNS = 'id, type, status, created_at, payload';

function employeesSelectForCompany(sb: SupabaseClient, cols: string, companyId: string) {
  const q = sb.from('employees').select(cols);
  if (companyId) return q.eq('company_id', companyId);
  return q;
}

const EMPLOYEE_LIST_COLUMNS_NO_EMAIL =
  'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta';

const EMPLOYEE_MANAGER_COLUMNS_NO_EMAIL =
  'id, auth_user_id, first_name, last_name, display_name, phone, staff_type, usual_restaurant, hourly_rate, clock_pin, meta, weekly_grid';

async function selectEmployees(
  sb: SupabaseClient,
  cols: string,
  fallbackCols: string,
  companyId: string
) {
  const primary = await employeesSelectForCompany(sb, cols, companyId).order('display_name', {
    ascending: true,
  });
  if (!primary.error) return primary;
  if (/email/i.test(primary.error.message || '')) {
    return employeesSelectForCompany(sb, fallbackCols, companyId).order('display_name', {
      ascending: true,
    });
  }
  return primary;
}

export async function hydrateFromSupabase(
  sb: SupabaseClient,
  opts?: { role?: 'manager' | 'employee' | null; userId?: string | null }
): Promise<HydrationResult> {
  const teamStateId = await readStoredTeamStateId();
  const companyId = await resolveCompanyIdForEmployees();
  const isManager = opts?.role === 'manager';
  const teamCols = isManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
  const empCols = isManager ? EMPLOYEE_MANAGER_COLUMNS : EMPLOYEE_LIST_COLUMNS;
  const empFallback = isManager ? EMPLOYEE_MANAGER_COLUMNS_NO_EMAIL : EMPLOYEE_LIST_COLUMNS_NO_EMAIL;

  const [empRes, reqRes, teamRes] = await Promise.all([
    selectEmployees(sb, empCols, empFallback, companyId),
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
    let selfQ = sb.from('employees').select('id, weekly_grid').eq('auth_user_id', opts.userId);
    if (companyId) selfQ = selfQ.eq('company_id', companyId);
    const selfRes = await selfQ.maybeSingle();
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
  const companyId = await resolveCompanyIdForEmployees();
  const isManager = opts?.role === 'manager';
  const empCols = isManager ? EMPLOYEE_MANAGER_COLUMNS : EMPLOYEE_LIST_COLUMNS;
  const empFallback = isManager ? EMPLOYEE_MANAGER_COLUMNS_NO_EMAIL : EMPLOYEE_LIST_COLUMNS_NO_EMAIL;
  const empRes = await selectEmployees(sb, empCols, empFallback, companyId);
  const employees: EmployeeRow[] = [];
  if (empRes.data?.length) {
    for (const row of empRes.data) {
      const m = mapEmployeeFromDb(row as unknown as Record<string, unknown>);
      if (m) employees.push(m);
    }
  }
  if (opts?.role === 'employee' && opts.userId) {
    let selfQ = sb.from('employees').select('id, weekly_grid').eq('auth_user_id', opts.userId);
    if (companyId) selfQ = selfQ.eq('company_id', companyId);
    const selfRes = await selfQ.maybeSingle();
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
