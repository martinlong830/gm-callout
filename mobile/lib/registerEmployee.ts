import type { SupabaseClient } from '@supabase/supabase-js';
import { assignEmployeeClockPin, saveEmployeeRow } from './employeeSave';
import { isCloudEmployeeId, type EmployeeRow } from './employees';
import { normalizeWeeklyGrid } from './weeklyAvailabilityMatrix';
import type { DraftGrid } from './schedule/types';

const EMPTY_DRAFT: DraftGrid = { Kitchen: [], Bartender: [], Server: [] };

export type RegisterEmployeeInput = {
  firstName: string;
  lastName: string;
  phone: string;
  staffType: 'Kitchen' | 'Bartender' | 'Server';
  authUserId?: string;
};

export async function createEmployeeRosterRow(
  sb: SupabaseClient,
  input: RegisterEmployeeInput,
  draftRows: DraftGrid = EMPTY_DRAFT
): Promise<{ ok: true; employee: EmployeeRow } | { ok: false; message: string }> {
  const fn = String(input.firstName || '').trim();
  const ln = String(input.lastName || '').trim();
  const phone = String(input.phone || '').trim();
  if (!fn || !ln) return { ok: false, message: 'First and last name are required.' };
  if (!phone) return { ok: false, message: 'Phone number is required.' };
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) {
    return { ok: false, message: 'Enter a valid phone number (at least 7 digits).' };
  }

  const displayName = `${fn} ${ln}`.trim();
  const staffType = input.staffType;
  const emp: EmployeeRow = {
    id:
      typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID
        ? globalThis.crypto.randomUUID()
        : `emp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    authUserId: input.authUserId,
    firstName: fn,
    lastName: ln,
    displayName,
    staffType,
    phone,
    usualRestaurant: 'rp-9',
    weeklyGrid: normalizeWeeklyGrid({}, staffType, draftRows) as unknown as Record<string, unknown>,
    meta: {},
  };

  const saved = await saveEmployeeRow(sb, emp);
  if (!saved.ok) return saved;

  if (isCloudEmployeeId(emp.id)) {
    await assignEmployeeClockPin(sb, emp.id);
  }

  return { ok: true, employee: emp };
}
