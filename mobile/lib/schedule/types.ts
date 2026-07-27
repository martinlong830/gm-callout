export type WeekdayKey = 'Mon' | 'Tue' | 'Wed' | 'Thu' | 'Fri' | 'Sat' | 'Sun';

export type RoleKey = 'Bartender' | 'Kitchen' | 'Server';

export type WeekMeta = {
  label: string;
  weekdayKey: WeekdayKey;
  dayNameUpper: string;
  iso: string;
  weekIndex: number;
  dayInWeek: number;
  globalDayIndex: number;
};

export type ScheduleRow = {
  id: string;
  day: string;
  trIdx: number;
  role: RoleKey;
  roleClass: string;
  groupLabel: string;
  start: string;
  end: string;
  slotKey: string;
  timeLabel: string;
  redPokeBreak: string;
  redPokeHours: string;
  workers: string[];
  worker: string;
  /** Per-shift override; falls back to employee break policy when unset. */
  breakPaid?: boolean;
};

export type Restaurant = { id: string; name: string; shortLabel: string; defaultUnassignedSchedule?: boolean };

export type EmployeeLite = {
  firstName: string;
  lastName: string;
  displayName?: string;
  staffType: RoleKey;
  usualRestaurant: string;
  meta?: { scheduleAliases?: string[]; hiringDate?: string; position?: string };
};

export type DraftGrid = Record<RoleKey, (Array<string | null> | null)[][]>;

/**
 * Per-restaurant custom schedule row order within each role section.
 * Values are draft `trIdx` indices in display order.
 * Absent / empty role → stable trIdx order (`0..slotN-1`).
 */
export type SlotOrderByRole = Partial<Record<RoleKey, number[]>>;
export type SlotOrderByRestaurant = Record<string, SlotOrderByRole>;

/**
 * Per-week slot order SoT: monday ISO → restaurant → role → trIdx[].
 * Legacy global `slotOrderByRestaurant` is read as fallback when a week has no entry.
 */
export type SlotOrderByWeek = Record<string, SlotOrderByRestaurant>;

/** Legacy `['Name']` or FOH sheet `{ workers, break?, hours?, timeLabel? }`. */
export type ScheduleAssignmentEntry =
  | string[]
  | {
      workers: string[];
      break?: string;
      hours?: string;
      timeLabel?: string;
      breakPaid?: boolean;
    };

export type AssignmentStore = Record<string, Record<string, ScheduleAssignmentEntry>>;
