import type { EmployeeRow } from '../employees';
import type { TimeClockEntry } from './types';

export type ShiftBreakLike = { breakPaid?: boolean | null };

export function employeeBreakPolicy(emp: EmployeeRow | null | undefined): 'paid' | 'unpaid' {
  const p = emp?.meta?.breakPolicy;
  return p === 'paid' ? 'paid' : 'unpaid';
}

export function shiftBreakPaidOverride(shift: ShiftBreakLike | null | undefined): boolean | null {
  if (!shift || shift.breakPaid == null) return null;
  return !!shift.breakPaid;
}

export function entryBreakPaidOverride(entry: TimeClockEntry | null | undefined): boolean | null {
  if (!entry || entry.break_paid == null) return null;
  return !!entry.break_paid;
}

export function resolveBreakPaid(opts: {
  entry?: TimeClockEntry | null;
  shift?: ShiftBreakLike | null;
  emp?: EmployeeRow | null;
}): boolean {
  const entryOverride = entryBreakPaidOverride(opts.entry);
  if (entryOverride != null) return entryOverride;
  const shiftOverride = shiftBreakPaidOverride(opts.shift);
  if (shiftOverride != null) return shiftOverride;
  return employeeBreakPolicy(opts.emp) === 'paid';
}

export function unpaidBreakMinutes(breakMins: number, isPaid: boolean): number {
  const m = Math.max(0, Math.round(Number(breakMins) || 0));
  if (!m || isPaid) return 0;
  return m;
}

export function formatBreakPolicyLabel(isPaid: boolean): string {
  return isPaid ? 'Paid' : 'Unpaid';
}
