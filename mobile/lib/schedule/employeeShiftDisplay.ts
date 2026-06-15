import type { WeekMeta } from './types';
import type { WorkerShiftRow } from './engine';
import { getThisMondayDate } from './engine';
import { isoFromDate } from '../timecards/payWeek';

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

export function parseIsoDate(iso: string): Date | null {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

/** e.g. "Mon May 23" — manager timecards shift list date column. */
export function formatPayWeekDateLabel(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${WEEKDAYS_SHORT[d.getDay()]} ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/** e.g. "Monday, Jan 5" — matches web employee shift list. */
export function formatCalendarDateLabel(row: Pick<WorkerShiftRow, 'iso' | 'day'>): string {
  const d = parseIsoDate(row.iso);
  if (!d || Number.isNaN(d.getTime())) {
    return row.day ? String(row.day) : '';
  }
  return `${WEEKDAYS_LONG[d.getDay()]}, ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

export function weekStartIsoFromIso(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d || Number.isNaN(d.getTime())) return '';
  const day = d.getDay();
  const monOffset = day === 0 ? -6 : 1 - day;
  const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + monOffset);
  return isoFromDate(mon);
}

/** Center label for upcoming week pager (web `formatWeekHeaderLabel`). */
export function formatWeekOfLabel(weekStartIso: string): string {
  const d = parseIsoDate(weekStartIso);
  if (!d || Number.isNaN(d.getTime())) return 'Upcoming';
  return `Week of ${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}`;
}

/** Chip label (web manager schedule / week range). */
export function formatScheduleWeekRangeLabel(weekMeta: WeekMeta[], weekIndex: number): string {
  const i0 = weekIndex * 7;
  const m0 = weekMeta[i0];
  const m6 = weekMeta[Math.min(i0 + 6, weekMeta.length - 1)];
  if (!m0 || !m6) return `Week ${weekIndex + 1}`;
  const d0 = m0.label.replace(/^[A-Za-z]+\s+/, '');
  const d6 = m6.label.replace(/^[A-Za-z]+\s+/, '');
  return `${d0} – ${d6}`;
}

export function currentScheduleWeekIndex(weekMeta: WeekMeta[]): number {
  const monIso = isoFromDate(getThisMondayDate());
  const hit = weekMeta.find((m) => m.iso === monIso);
  return hit?.weekIndex ?? 0;
}

export function weekIndexFromIso(weekMeta: WeekMeta[], iso: string): number {
  const hit = weekMeta.find((m) => m.iso === iso);
  if (hit != null) return hit.weekIndex;
  const mon = weekStartIsoFromIso(iso);
  const hitMon = weekMeta.find((m) => m.iso === mon);
  return hitMon?.weekIndex ?? 0;
}

export function partitionShiftsByWeekStart(rows: WorkerShiftRow[]): {
  order: string[];
  byWeek: Record<string, WorkerShiftRow[]>;
} {
  const byWeek: Record<string, WorkerShiftRow[]> = {};
  const order: string[] = [];
  for (const r of rows) {
    const wk = weekStartIsoFromIso(r.iso) || 'unknown';
    if (!byWeek[wk]) {
      byWeek[wk] = [];
      order.push(wk);
    }
    byWeek[wk].push(r);
  }
  for (const wk of order) {
    byWeek[wk].sort((a, b) => a.start.localeCompare(b.start));
  }
  order.sort((a, b) => a.localeCompare(b));
  return { order, byWeek };
}

export function shiftsForWeekIndex(
  rows: WorkerShiftRow[],
  weekMeta: WeekMeta[],
  weekIndex: number
): WorkerShiftRow[] {
  return rows.filter((r) => weekIndexFromIso(weekMeta, r.iso) === weekIndex);
}

export function uniqueWeekIndicesWithShifts(
  rows: WorkerShiftRow[],
  weekMeta: WeekMeta[]
): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of rows) {
    const wi = weekIndexFromIso(weekMeta, r.iso);
    if (seen.has(wi)) continue;
    seen.add(wi);
    out.push(wi);
  }
  out.sort((a, b) => a - b);
  return out;
}

export function compactShiftTimeLabel(row: WorkerShiftRow): string {
  return row.timeLabel || `${row.start} – ${row.end}`;
}

export function shiftOptionKey(row: WorkerShiftRow): string {
  return `${row.restaurantId}-${row.id}-${row.iso}`;
}
