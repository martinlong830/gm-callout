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

export type LeavePeriod = {
  key: string;
  start: string;
  end: string;
  label: string;
};

export type LeaveComputedSide = {
  allowanceDays: number;
  usedDays: number;
  usedHours: number;
  allowanceHours: number;
  remainingHours: number;
  entries: LeaveEntry[];
  note: string;
};

export type ComputeLeaveBalanceOpts = {
  hiringDate?: string;
  asOfIso?: string;
  vacationPeriodKey?: string;
  sickPeriodKey?: string;
};

export function todayIsoLocal() {
  const d = new Date();
  return isoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/** Parse Team hiring date strings like "3/25/2023" or ISO. */
export function parseHiringMonthDay(hiringDateStr: string | null | undefined): {
  year: number;
  month: number;
  day: number;
} | null {
  const s = String(hiringDateStr || '').trim();
  if (!s) return null;
  const isoM = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoM) {
    return {
      year: parseInt(isoM[1], 10),
      month: parseInt(isoM[2], 10),
      day: parseInt(isoM[3], 10),
    };
  }
  const us = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    let y = parseInt(us[3], 10);
    if (y < 100) y += 2000;
    return { year: y, month: parseInt(us[1], 10), day: parseInt(us[2], 10) };
  }
  return null;
}

export function filterEntriesInRange(
  entries: LeaveEntry[] | null | undefined,
  startIso: string,
  endIso: string
): LeaveEntry[] {
  const start = String(startIso || '').slice(0, 10);
  const end = String(endIso || '').slice(0, 10);
  return (entries || []).filter((e) => {
    const d = String(e.date || '').slice(0, 10);
    if (!d) return false;
    if (start && d < start) return false;
    if (end && d > end) return false;
    return true;
  });
}

/** Sick leave period = calendar year (resets Jan 1). */
export function sickPeriodForAsOf(asOfIso?: string | null): LeavePeriod {
  let y = parseInt(String(asOfIso || todayIsoLocal()).slice(0, 4), 10);
  if (!y || Number.isNaN(y)) y = new Date().getFullYear();
  return {
    key: String(y),
    start: isoDate(y, 1, 1),
    end: isoDate(y, 12, 31),
    label: String(y),
  };
}

/**
 * Vacation period = hire-anniversary year (resets on hiring month/day each year).
 * Falls back to calendar year when hiring date is missing.
 */
export function vacationPeriodForAsOf(
  hiringDateStr?: string | null,
  asOfIso?: string | null
): LeavePeriod {
  const asOf = String(asOfIso || todayIsoLocal()).slice(0, 10);
  const hire = parseHiringMonthDay(hiringDateStr);
  if (!hire || !hire.month || !hire.day) {
    return sickPeriodForAsOf(asOf);
  }
  const asOfY = parseInt(asOf.slice(0, 4), 10);
  const asOfM = parseInt(asOf.slice(5, 7), 10);
  const asOfD = parseInt(asOf.slice(8, 10), 10);
  const pastAnniversary = asOfM > hire.month || (asOfM === hire.month && asOfD >= hire.day);
  const startY = pastAnniversary ? asOfY : asOfY - 1;
  const endY = startY + 1;
  const start = isoDate(startY, hire.month, hire.day);
  const endDate = new Date(endY, hire.month - 1, hire.day);
  endDate.setDate(endDate.getDate() - 1);
  const end = isoDate(endDate.getFullYear(), endDate.getMonth() + 1, endDate.getDate());
  return {
    key: start,
    start,
    end,
    label: `${formatUsDate(start)} – ${formatUsDate(end)}`,
  };
}

export function leavePeriodForKind(
  kind: 'vacation' | 'sick',
  hiringDateStr?: string | null,
  asOfIso?: string | null
): LeavePeriod {
  return kind === 'vacation'
    ? vacationPeriodForAsOf(hiringDateStr, asOfIso)
    : sickPeriodForAsOf(asOfIso);
}

export function listLeavePeriodsFromEntries(
  kind: 'vacation' | 'sick',
  entries: LeaveEntry[] | null | undefined,
  hiringDateStr?: string | null,
  asOfIso?: string | null
): LeavePeriod[] {
  const asOf = String(asOfIso || todayIsoLocal()).slice(0, 10);
  const current = leavePeriodForKind(kind, hiringDateStr, asOf);
  const byKey: Record<string, LeavePeriod> = { [current.key]: current };
  for (const e of entries || []) {
    const d = String(e.date || '').slice(0, 10);
    if (!d) continue;
    const p = leavePeriodForKind(kind, hiringDateStr, d);
    if (!byKey[p.key]) byKey[p.key] = p;
  }
  return Object.keys(byKey)
    .map((k) => byKey[k])
    .sort((a, b) => String(b.start).localeCompare(String(a.start)));
}

export function computeLeaveSide(side: LeaveSide, periodEntries?: LeaveEntry[]): LeaveComputedSide {
  const entries = periodEntries != null ? periodEntries : side.entries || [];
  const hoursPerDay = side.hoursPerDay || LEAVE_HOURS_PER_DAY;
  const usedHours = sumHours(entries);
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
    entries,
    note: side.note ?? '',
  };
}

/**
 * Current-period used hours by default (SL calendar year; VL hire anniversary).
 * Pass vacationPeriodKey / sickPeriodKey to view a prior period.
 */
export function computeLeaveBalance(bal: LeaveBalance, opts?: ComputeLeaveBalanceOpts) {
  const o = opts || {};
  const b = normalizeLeaveBalance(bal);
  const asOf = o.asOfIso || todayIsoLocal();
  const hiringDate = o.hiringDate || '';
  let vacPeriod = vacationPeriodForAsOf(hiringDate, asOf);
  let sickPeriod = sickPeriodForAsOf(asOf);
  if (o.vacationPeriodKey) {
    const vacList = listLeavePeriodsFromEntries('vacation', b.vacation.entries, hiringDate, asOf);
    const found = vacList.find((p) => p.key === o.vacationPeriodKey);
    if (found) vacPeriod = found;
  }
  if (o.sickPeriodKey) {
    const sickList = listLeavePeriodsFromEntries('sick', b.sick.entries, hiringDate, asOf);
    const found = sickList.find((p) => p.key === o.sickPeriodKey);
    if (found) sickPeriod = found;
    else sickPeriod = sickPeriodForAsOf(`${o.sickPeriodKey}-01-01`);
  }
  return {
    vacation: computeLeaveSide(
      b.vacation,
      filterEntriesInRange(b.vacation.entries, vacPeriod.start, vacPeriod.end)
    ),
    sick: computeLeaveSide(b.sick, filterEntriesInRange(b.sick.entries, sickPeriod.start, sickPeriod.end)),
    vacationPeriod: vacPeriod,
    sickPeriod,
  };
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

/**
 * Append dated VL/SL usage entries (dedupe by date). When sick `hoursRemaining` is an
 * explicit override, deduct newly added hours so PTO totals stay consistent.
 */
export function appendLeaveBalanceEntries(
  emp: EmployeeRow,
  leaveType: 'sick' | 'vacation',
  entries: LeaveEntry[]
): { addedHours: number; addedDates: string[] } {
  ensureEmployeeLeaveBalance(emp);
  const bal = normalizeLeaveBalance(emp.meta?.leaveBalance);
  const side = leaveType === 'sick' ? bal.sick : bal.vacation;
  const existingDates = new Set(
    side.entries.map((e) => String(e.date || '').slice(0, 10)).filter(Boolean)
  );
  let addedHours = 0;
  const addedDates: string[] = [];
  for (const raw of entries) {
    const date = String(raw.date || '').slice(0, 10);
    if (!date || existingDates.has(date)) continue;
    const hours = Math.max(0, Number(raw.hours) || LEAVE_HOURS_PER_DAY);
    if (hours <= 0) continue;
    side.entries.push({ date, hours });
    existingDates.add(date);
    addedHours += hours;
    addedDates.push(date);
  }
  if (leaveType === 'sick' && bal.sick.hoursRemaining != null && addedHours > 0) {
    bal.sick.hoursRemaining = Math.max(0, Number(bal.sick.hoursRemaining) - addedHours);
  }
  if (!emp.meta) emp.meta = {};
  emp.meta.leaveBalance = bal;
  return { addedHours, addedDates };
}

/**
 * Set VL or SL hours for a date (replace). hours <= 0 removes the entry.
 */
export function upsertLeaveBalanceEntry(
  emp: EmployeeRow,
  leaveType: 'sick' | 'vacation',
  dateIso: string,
  hours: number
): { changed: boolean; previousHours?: number; hours?: number } {
  ensureEmployeeLeaveBalance(emp);
  const date = String(dateIso || '').slice(0, 10);
  if (!date) return { changed: false };
  const hrs = Math.max(0, Number(hours) || 0);
  const bal = normalizeLeaveBalance(emp.meta?.leaveBalance);
  const side = leaveType === 'sick' ? bal.sick : bal.vacation;
  const entries = side.entries || [];
  let idx = -1;
  let prevHours = 0;
  for (let i = 0; i < entries.length; i += 1) {
    if (String(entries[i].date || '').slice(0, 10) === date) {
      idx = i;
      prevHours = Math.max(0, Number(entries[i].hours) || 0);
      break;
    }
  }
  let changed = false;
  if (hrs <= 0) {
    if (idx >= 0) {
      entries.splice(idx, 1);
      changed = true;
    }
  } else if (idx >= 0) {
    if (prevHours !== hrs) {
      entries[idx] = { date, hours: hrs };
      changed = true;
    }
  } else {
    entries.push({ date, hours: hrs });
    changed = true;
  }
  side.entries = entries;
  if (changed && leaveType === 'sick' && side.hoursRemaining != null) {
    const delta = hrs - prevHours;
    side.hoursRemaining = Math.max(0, Number(side.hoursRemaining) - delta);
  }
  if (!emp.meta) emp.meta = {};
  emp.meta.leaveBalance = bal;
  return { changed, previousHours: prevHours, hours: hrs };
}

export function applyLeaveSeedsToEmployees(employees: EmployeeRow[]): number {
  let n = 0;
  for (const emp of employees) {
    if (ensureEmployeeLeaveBalance(emp)) n += 1;
  }
  return n;
}

const LEAVE_FROM_TIMECARDS_MIGRATED_KEY = 'gm-leave-from-timecards-migrated-v1';

/**
 * One-time: copy prior Timecards VL/SL day overrides into Team leaveBalance history.
 * Returns employees whose leaveBalance changed (caller should persist).
 */
export async function migrateTimecardLeaveIntoTeamHistory(
  employees: EmployeeRow[]
): Promise<EmployeeRow[]> {
  try {
    const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
    if ((await AsyncStorage.getItem(LEAVE_FROM_TIMECARDS_MIGRATED_KEY)) === '1') {
      return [];
    }
    let all: Record<string, unknown> | null = null;
    try {
      const raw = await AsyncStorage.getItem('gm-timecard-week-extras-v1');
      all = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      all = null;
    }
    if (!all || typeof all !== 'object') {
      await AsyncStorage.setItem(LEAVE_FROM_TIMECARDS_MIGRATED_KEY, '1');
      return [];
    }
    const byId: Record<string, EmployeeRow> = {};
    for (const e of employees) {
      if (e?.id) byId[e.id] = e;
    }
    const changedIds = new Set<string>();
    for (const weekKey of Object.keys(all)) {
      const slice = all[weekKey];
      if (!slice || typeof slice !== 'object') continue;
      for (const k of Object.keys(slice as Record<string, unknown>)) {
        const at = k.indexOf('@');
        if (at < 0) continue;
        const empId = k.slice(0, at);
        const iso = k.slice(at + 1);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) continue;
        const row = (slice as Record<string, unknown>)[k] as
          | { vl?: unknown; sl?: unknown; manual?: boolean }
          | null;
        if (!row || row.manual === false) continue;
        const emp = byId[empId];
        if (!emp) continue;
        const vl = Math.max(0, parseFloat(String(row.vl)) || 0);
        const sl = Math.max(0, parseFloat(String(row.sl)) || 0);
        if (vl > 0) {
          const rv = upsertLeaveBalanceEntry(emp, 'vacation', iso, vl);
          if (rv.changed) changedIds.add(emp.id);
        }
        if (sl > 0) {
          const rs = upsertLeaveBalanceEntry(emp, 'sick', iso, sl);
          if (rs.changed) changedIds.add(emp.id);
        }
      }
    }
    await AsyncStorage.setItem(LEAVE_FROM_TIMECARDS_MIGRATED_KEY, '1');
    return [...changedIds].map((id) => byId[id]).filter(Boolean);
  } catch {
    return [];
  }
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
  const hiringDate =
    emp.meta?.hiringDate != null ? String(emp.meta.hiringDate).trim() : '';
  const c = computeLeaveBalance(bal, { hiringDate });
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
  if (c.sick.remainingHours != null && bal.sick.allowanceHours != null) {
    lines.push(
      `  · ${formatLeaveHours(c.sick.remainingHours)} sick hrs remaining (of ${formatLeaveHours(c.sick.allowanceHours)} hr bank)`
    );
  }
  return lines;
}
