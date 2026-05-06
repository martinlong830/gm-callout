import type { SupabaseClient } from '@supabase/supabase-js';
import { TEAM_STATE_ROW_ID } from './constants';
import { mapEmployeeFromDb, type EmployeeRow } from './employees';
import { mapStaffRequestFromDbRow, type StaffRequestUi } from './staffRequests';

export type HydrationResult = {
  employees: EmployeeRow[];
  staffRequests: StaffRequestUi[];
  teamState: Record<string, unknown> | null;
};

export async function hydrateFromSupabase(sb: SupabaseClient): Promise<HydrationResult> {
  const [empRes, reqRes, teamRes] = await Promise.all([
    sb.from('employees').select('*').order('display_name', { ascending: true }),
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

  const teamState =
    teamRes.data && typeof teamRes.data === 'object'
      ? (teamRes.data as Record<string, unknown>)
      : null;

  return { employees, staffRequests, teamState };
}
