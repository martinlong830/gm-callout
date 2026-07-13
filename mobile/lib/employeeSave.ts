import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCompanyIdForEmployees } from './companySession';
import { employeeDisplayName, isCloudEmployeeId, type EmployeeRow } from './employees';
import { normalizeLeaveBalance, type LeaveBalance } from './employeeLeave';

export function employeeToDbRow(
  emp: EmployeeRow,
  companyId?: string
): Record<string, unknown> {
  const display = employeeDisplayName(emp);
  const ur = emp.usualRestaurant;
  let urDb: string = 'rp-9';
  if (ur === 'both') {
    urDb = 'both';
  } else if (ur === 'rp-8' || ur === 'rp-9') {
    urDb = ur;
  }
  const meta =
    emp.meta && typeof emp.meta === 'object' ? { ...emp.meta } : ({} as Record<string, unknown>);
  if (emp.tipPoint != null && !Number.isNaN(Number(emp.tipPoint))) {
    meta.tipPoint = emp.tipPoint;
  } else if ('tipPoint' in meta) {
    delete meta.tipPoint;
  }
  const row: Record<string, unknown> = {
    id: emp.id,
    auth_user_id: emp.authUserId ?? null,
    first_name: emp.firstName || '',
    last_name: emp.lastName || '',
    display_name: (display || '').trim() || 'Staff',
    phone: emp.phone != null ? String(emp.phone) : '',
    staff_type: emp.staffType,
    usual_restaurant: urDb,
    weekly_grid: emp.weeklyGrid || {},
    meta,
  };
  if (companyId) row.company_id = companyId;
  if (emp.clockPin) row.clock_pin = String(emp.clockPin);
  if (emp.hourlyRate != null && !Number.isNaN(Number(emp.hourlyRate))) {
    row.hourly_rate = Math.round(Number(emp.hourlyRate) * 100) / 100;
  }
  return row;
}

export async function saveEmployeeRow(
  sb: SupabaseClient,
  emp: EmployeeRow
): Promise<{ ok: true } | { ok: false; message: string }> {
  const companyId = await resolveCompanyIdForEmployees();
  const row = employeeToDbRow(emp, companyId || undefined);
  const { error } = await sb.from('employees').upsert(row, { onConflict: 'id' });
  if (error) return { ok: false, message: error.message || 'Could not save employee.' };
  return { ok: true };
}

export async function assignEmployeeClockPin(
  sb: SupabaseClient,
  employeeId: string
): Promise<{ ok: true; pin: string } | { ok: false; message: string }> {
  if (!isCloudEmployeeId(employeeId)) {
    return { ok: false, message: 'Save employee to cloud roster before assigning a PIN.' };
  }
  const res = await sb.rpc('assign_employee_clock_pin', { p_employee_id: employeeId });
  if (res.error) return { ok: false, message: res.error.message || 'Could not assign PIN.' };
  const pin = res.data != null ? String(res.data) : '';
  if (!pin) return { ok: false, message: 'No PIN returned.' };
  return { ok: true, pin };
}

export async function setEmployeeClockPin(
  sb: SupabaseClient,
  employeeId: string,
  pinInput: string
): Promise<{ ok: true; pin: string } | { ok: false; message: string }> {
  if (!isCloudEmployeeId(employeeId)) {
    return { ok: false, message: 'Save employee to cloud roster before setting a PIN.' };
  }
  const pin = String(pinInput || '').replace(/\D/g, '');
  if (pin.length !== 4) {
    return { ok: false, message: 'PIN must be exactly 4 digits.' };
  }
  const res = await sb.rpc('set_employee_clock_pin', {
    p_employee_id: employeeId,
    pin_input: pin,
  });
  if (res.error) return { ok: false, message: res.error.message || 'Could not save PIN.' };
  const out = res.data != null ? String(res.data) : pin;
  return { ok: true, pin: out };
}

export function applyLeaveAllowancesToMeta(
  meta: Record<string, unknown>,
  fields: {
    vacAllowanceDays: string;
    sickAllowanceDays: string;
    sickAllowanceHours: string;
    sickHoursRemaining: string;
  }
): LeaveBalance {
  const bal = normalizeLeaveBalance(meta.leaveBalance);
  const vacDays = Math.max(0, parseInt(fields.vacAllowanceDays, 10) || 0);
  const sickDays = Math.max(0, parseInt(fields.sickAllowanceDays, 10) || 0);
  bal.vacation.allowanceDays = vacDays;
  bal.sick.allowanceDays = sickDays;
  const sickHrs = fields.sickAllowanceHours.trim();
  const sickRem = fields.sickHoursRemaining.trim();
  bal.sick.allowanceHours = sickHrs === '' ? null : Math.max(0, parseFloat(sickHrs) || 0);
  bal.sick.hoursRemaining = sickRem === '' ? null : Math.max(0, parseFloat(sickRem) || 0);
  meta.leaveBalance = bal;
  return bal;
}
