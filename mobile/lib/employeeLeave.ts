import { employeeDisplayName, type EmployeeRow } from './employees';

export const LEAVE_HOURS_PER_DAY = 8;

export type LeaveEntry = { date: string; hours: number };

export type LeaveSide = {
  allowanceDays: number;
  hoursPerDay: number;
  entries: LeaveEntry[];
  allowanceHours?: number | null;
  hoursRemaining?: number | null;
  note?: string;
};

export type LeaveBalance = {
  version: number;
  vacation: LeaveSide;
  sick: LeaveSide;
};

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

function isoDate(y: number, m: number, d: number) {
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function dayEntries(y: number, m: number, start: number, end: number, hours = LEAVE_HOURS_PER_DAY): LeaveEntry[] {
  const out: LeaveEntry[] = [];
  for (let d = start; d <= end; d += 1) out.push({ date: isoDate(y, m, d), hours });
  return out;
}

function balance(
  vacAllow: number,
  sickAllow: number,
  vacEntries: LeaveEntry[],
  sickEntries: LeaveEntry[],
  sickExtra?: { allowanceHours?: number; hoursRemaining?: number; note?: string }
): LeaveBalance {
  return {
    version: 1,
    vacation: { allowanceDays: vacAllow, hoursPerDay: LEAVE_HOURS_PER_DAY, entries: vacEntries },
    sick: {
      allowanceDays: sickAllow,
      hoursPerDay: LEAVE_HOURS_PER_DAY,
      entries: sickEntries,
      allowanceHours: sickExtra?.allowanceHours ?? null,
      hoursRemaining: sickExtra?.hoursRemaining ?? null,
      note: sickExtra?.note ?? '',
    },
  };
}

const TEAM_LEAVE_SEED: Record<string, LeaveBalance> = {
  'mark ong': balance(10, 5, [{ date: '2026-04-10', hours: 8 }], []),
  'charles jakob zacani': balance(5, 5, dayEntries(2025, 11, 17, 21), []),
  'eugene villarruz': balance(
    5,
    7,
    [],
    [
      { date: '2026-03-28', hours: 9.5 },
      { date: '2026-05-04', hours: 9.5 },
    ],
    {
      allowanceHours: 61,
      hoursRemaining: 21,
    }
  ),
  'maeve williams': balance(0, 5, [], [
    { date: '2026-01-26', hours: 8 },
    { date: '2026-01-27', hours: 8 },
  ]),
  'jon arellano': balance(0, 0, [], []),
  'baltazar lucas': balance(5, 5, dayEntries(2026, 1, 19, 23), []),
  'enrique cumes': balance(5, 5, dayEntries(2025, 11, 24, 28), [{ date: '2026-03-08', hours: 10.5 }]),
  'armando cumes': balance(5, 5, dayEntries(2025, 12, 22, 26), [{ date: '2026-04-07', hours: 8.5 }]),
  'bernabe de leon': balance(0, 5, [], [{ date: '2026-02-04', hours: 8 }]),
  'zeferino flores': balance(0, 5, [], [{ date: '2026-04-19', hours: 11.5 }]),
  'juan salvatierra': balance(5, 5, dayEntries(2026, 2, 11, 15), []),
  'natalio de la cruz': balance(5, 5, dayEntries(2025, 12, 1, 5), []),
  'abel lujan': balance(0, 5, [], []),
};

function normNameKey(s: string) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function leaveKey(name: string) {
  const k = normNameKey(name);
  if (TEAM_LEAVE_SEED[k]) return k;
  const parts = k.split(' ').filter(Boolean);
  if (parts.length >= 2) {
    const fl = `${parts[0]} ${parts[parts.length - 1]}`;
    if (TEAM_LEAVE_SEED[fl]) return fl;
  }
  return k;
}

export function defaultLeaveBalance(): LeaveBalance {
  return balance(0, 5, [], []);
}

export function getSeedForName(displayName: string): LeaveBalance | null {
  const key = leaveKey(displayName);
  const seed = TEAM_LEAVE_SEED[key];
  return seed ? JSON.parse(JSON.stringify(seed)) as LeaveBalance : null;
}

export function normalizeLeaveBalance(raw: unknown): LeaveBalance {
  if (!raw || typeof raw !== 'object') return defaultLeaveBalance();
  const r = raw as Partial<LeaveBalance>;
  const mapEntries = (entries: unknown): LeaveEntry[] =>
    Array.isArray(entries)
      ? entries.map((e) => {
          const x = e as LeaveEntry;
          return { date: String(x.date ?? '').trim(), hours: Math.max(0, Number(x.hours) || LEAVE_HOURS_PER_DAY) };
        })
      : [];
  const vac = (r.vacation ?? {}) as Partial<LeaveSide>;
  const sick = (r.sick ?? {}) as Partial<LeaveSide>;
  return {
    version: 1,
    vacation: {
      allowanceDays: Math.max(0, Number(vac.allowanceDays) || 0),
      hoursPerDay: Math.max(0, Number(vac.hoursPerDay) || LEAVE_HOURS_PER_DAY),
      entries: mapEntries(vac.entries),
    },
    sick: {
      allowanceDays: Math.max(0, Number(sick.allowanceDays) || 0),
      hoursPerDay: Math.max(0, Number(sick.hoursPerDay) || LEAVE_HOURS_PER_DAY),
      entries: mapEntries(sick.entries),
      allowanceHours: sick.allowanceHours != null ? Math.max(0, Number(sick.allowanceHours) || 0) : null,
      hoursRemaining: sick.hoursRemaining != null ? Math.max(0, Number(sick.hoursRemaining) || 0) : null,
      note: (() => {
        const n = String(sick.note ?? '');
        if (
          n ===
          '40 hours total sick bank; 21 hours remaining after listed dates (19 hrs used on 3/28 and 5/4).'
        ) {
          return '';
        }
        return n;
      })(),
    },
  };
}

function sumHours(entries: LeaveEntry[]) {
  return entries.reduce((t, e) => t + (Number(e.hours) || 0), 0);
}

export type LeaveComputedSide = {
  allowanceDays: number;
  usedDays: number;
  usedHours: number;
  allowanceHours: number;
  remainingHours: number;
  entries: LeaveEntry[];
  note: string;
};

export function computeLeaveSide(side: LeaveSide): LeaveComputedSide {
  const hoursPerDay = side.hoursPerDay || LEAVE_HOURS_PER_DAY;
  const usedHours = sumHours(side.entries);
  const allowanceDays = side.allowanceDays || 0;
  const allowanceHours = side.allowanceHours ?? allowanceDays * hoursPerDay;
  const usedDays = hoursPerDay > 0 ? Math.round((usedHours / hoursPerDay) * 100) / 100 : 0;
  const remainingHours = side.hoursRemaining ?? Math.max(0, allowanceHours - usedHours);
  return {
    allowanceDays,
    usedDays,
    usedHours,
    allowanceHours,
    remainingHours,
    entries: side.entries,
    note: side.note ?? '',
  };
}

export function computeLeaveBalance(bal: LeaveBalance) {
  const b = normalizeLeaveBalance(bal);
  return { vacation: computeLeaveSide(b.vacation), sick: computeLeaveSide(b.sick) };
}

export function ensureEmployeeLeaveBalance(emp: EmployeeRow): boolean {
  if (!emp.meta) emp.meta = {};
  if (emp.meta.leaveBalance && typeof emp.meta.leaveBalance === 'object') {
    emp.meta.leaveBalance = normalizeLeaveBalance(emp.meta.leaveBalance);
    return false;
  }
  const seed = getSeedForName(employeeDisplayName(emp));
  emp.meta.leaveBalance = seed ?? defaultLeaveBalance();
  emp.meta.leaveBalanceSeeded = 1;
  return true;
}

export function applyLeaveSeedsToEmployees(employees: EmployeeRow[]): number {
  let n = 0;
  for (const emp of employees) {
    if (ensureEmployeeLeaveBalance(emp)) n += 1;
  }
  return n;
}

export function formatUsDate(iso: string) {
  const p = iso.split('-');
  if (p.length !== 3) return iso;
  return `${pad2(parseInt(p[1], 10))}/${pad2(parseInt(p[2], 10))}/${p[0]}`;
}

export function formatLeaveHours(h: number) {
  const n = Math.round(h * 100) / 100;
  if (Math.abs(n - Math.round(n)) < 0.01) return String(Math.round(n));
  return n.toFixed(1);
}

export function leaveSummaryLines(emp: EmployeeRow): string[] {
  ensureEmployeeLeaveBalance(emp);
  const bal = normalizeLeaveBalance(emp.meta?.leaveBalance);
  const c = computeLeaveBalance(bal);
  const lines = [
    `Vacation: ${c.vacation.usedDays}/${c.vacation.allowanceDays} days used (${formatLeaveHours(c.vacation.usedHours)} hrs)`,
    `Sick: ${c.sick.usedDays}/${c.sick.allowanceDays} days used (${formatLeaveHours(c.sick.usedHours)} hrs)`,
  ];
  for (const e of c.vacation.entries) {
    lines.push(`  · Vacation ${formatUsDate(e.date)} — ${formatLeaveHours(e.hours)} hrs`);
  }
  for (const e of c.sick.entries) {
    lines.push(`  · Sick ${formatUsDate(e.date)} — ${formatLeaveHours(e.hours)} hrs`);
  }
  if (c.sick.note) lines.push(`  · ${c.sick.note}`);
  if (c.sick.hoursRemaining != null && bal.sick.allowanceHours != null) {
    lines.push(
      `  · ${formatLeaveHours(c.sick.remainingHours)} sick hrs remaining (of ${formatLeaveHours(c.sick.allowanceHours)} hr bank)`
    );
  }
  return lines;
}
