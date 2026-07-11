import type { WorkerShiftRow } from '../schedule/engine';

export type PayWeekBounds = { start: Date; end: Date };

export type TimeClockEntry = {
  id: string;
  employee_id: string;
  clock_in_at: string;
  clock_out_at: string | null;
  break_minutes?: number | null;
  break_start_at?: string | null;
  break_end_at?: string | null;
  break_segments?: Array<{ start?: string; end?: string; minutes?: number }> | null;
  break_paid?: boolean | null;
  schedule_shift_id?: string | null;
  clock_restaurant_id?: string | null;
  edit_history?: unknown;
  updated_at?: string;
};

export type TimecardSchema = {
  breakMinutes: boolean;
  breakTimes: boolean;
  scheduleShiftId: boolean;
  editHistory: boolean;
  breakPaid: boolean;
};

export type ShiftDayRow = {
  shift: WorkerShiftRow;
  iso: string;
  isToday: boolean;
  isUpcoming: boolean;
};

export type EmployeeClockStatus = 'clocked_in' | 'on_break' | 'off_clock';

export type RosterRow = {
  empId: string;
  name: string;
  role: string;
  deptRank: number;
  clockStatus: EmployeeClockStatus;
  clockStatusLabel: string;
  clockStatusRank: number;
  schedMins: number;
  regMins: number;
  otMins: number;
  regPay: number | null;
  otPay: number | null;
  grandTotalPay: number | null;
  vlHours: number;
  slHours: number;
  sohCount: number;
  sohDatesLabel: string;
  sohPay: number | null;
  vlPay: number | null;
  slPay: number | null;
  dishwasherTipsPay: number;
  /** Coverage compensation (week total). */
  additionalCashTip: number;
  status: string;
  statusRank: number;
};

export type RosterTotals = {
  headcount: number;
  schedMins: number;
  regMins: number;
  otMins: number;
  vlHours: number;
  slHours: number;
  sohCount: number;
  regPay: number;
  otPay: number;
  vlPay: number;
  slPay: number;
  sohPay: number;
  dishwasherTipsPay: number;
  additionalCashTip: number;
  grandTotalPay: number;
  totalMins: number;
  hasRegPay: boolean;
  hasOtPay: boolean;
  hasVlSlPay: boolean;
  hasSohPay: boolean;
  hasDishwasherTips: boolean;
  hasAdditionalCashTip: boolean;
  hasGrandTotal: boolean;
};

export type WeekExtras = { vl: number; sl: number; manual: boolean };
