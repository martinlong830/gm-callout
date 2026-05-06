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
};

export type Restaurant = { id: string; name: string; shortLabel: string; defaultUnassignedSchedule?: boolean };

export type EmployeeLite = {
  firstName: string;
  lastName: string;
  staffType: RoleKey;
  usualRestaurant: string;
};

export type DraftGrid = Record<RoleKey, (Array<string | null> | null)[][]>;

export type AssignmentStore = Record<string, Record<string, string[]>>;
