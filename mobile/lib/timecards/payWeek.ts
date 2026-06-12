import AsyncStorage from '@react-native-async-storage/async-storage';
import { getThisMondayDate } from '../schedule/engine';
import type { PayWeekBounds } from './types';

export const TIMECARDS_PAST_WEEK_COUNT = 12;
export const TIMECARDS_EARLIEST_PAY_WEEK_ISO = '2026-05-18';
const TIMECARDS_SELECTED_WEEK_KEY = 'gm-timecards-selected-pay-week-v1';

export type PayWeekOption = {
  startIso: string;
  label: string;
  isCurrent: boolean;
};

export function isoFromDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function payWeekBoundsFromMonday(mondayDate: Date): PayWeekBounds {
  const mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
  mon.setHours(0, 0, 0, 0);
  const sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
  sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
  return { start: mon, end: sunEnd };
}

export function currentPayWeekMondayIso(): string {
  return isoFromDate(getThisMondayDate());
}

export function earliestPayWeekMondayDate(): Date {
  return new Date(`${TIMECARDS_EARLIEST_PAY_WEEK_ISO}T12:00:00`);
}

function isPayWeekOnOrAfterEarliest(mondayDate: Date): boolean {
  const mon = new Date(mondayDate.getFullYear(), mondayDate.getMonth(), mondayDate.getDate());
  mon.setHours(0, 0, 0, 0);
  const earliest = earliestPayWeekMondayDate();
  earliest.setHours(0, 0, 0, 0);
  return mon.getTime() >= earliest.getTime();
}

export async function loadSelectedPayWeekStartIso(): Promise<string | null> {
  try {
    const v = await AsyncStorage.getItem(TIMECARDS_SELECTED_WEEK_KEY);
    return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

export async function saveSelectedPayWeekStartIso(iso: string | null): Promise<void> {
  try {
    if (!iso || iso === currentPayWeekMondayIso()) {
      await AsyncStorage.removeItem(TIMECARDS_SELECTED_WEEK_KEY);
    } else {
      await AsyncStorage.setItem(TIMECARDS_SELECTED_WEEK_KEY, iso);
    }
  } catch {
    /* ignore */
  }
}

export async function getSelectedPayWeekMondayDate(): Promise<Date> {
  const thisMon = getThisMondayDate();
  const stored = await loadSelectedPayWeekStartIso();
  if (!stored) return thisMon;
  const mon = new Date(`${stored}T12:00:00`);
  if (Number.isNaN(mon.getTime())) return thisMon;
  if (!isPayWeekOnOrAfterEarliest(mon)) return earliestPayWeekMondayDate();
  return mon;
}

export function getPayWeekBoundsForMonday(mondayDate: Date): PayWeekBounds {
  return payWeekBoundsFromMonday(mondayDate);
}

/** Current calendar week (Monday–Sunday), not the user-selected pay week. */
export function getCurrentPayWeekBounds(): PayWeekBounds {
  return payWeekBoundsFromMonday(getThisMondayDate());
}

export async function getActivePayWeekBounds(): Promise<PayWeekBounds> {
  const mon = await getSelectedPayWeekMondayDate();
  return payWeekBoundsFromMonday(mon);
}

export function formatPayWeekLabel(bounds: PayWeekBounds): string {
  const a = bounds.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const b = bounds.end.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `${a} – ${b}`;
}

export function weekBoundsStorageKey(bounds: PayWeekBounds): string {
  return `${isoFromDate(bounds.start)}_${isoFromDate(bounds.end)}`;
}

export function buildPayWeekOptions(): PayWeekOption[] {
  const thisMon = getThisMondayDate();
  const thisIso = isoFromDate(thisMon);
  const options: PayWeekOption[] = [];
  for (let i = TIMECARDS_PAST_WEEK_COUNT; i >= 0; i -= 1) {
    const mon = new Date(thisMon.getFullYear(), thisMon.getMonth(), thisMon.getDate() - i * 7);
    if (!isPayWeekOnOrAfterEarliest(mon)) continue;
    const bounds = payWeekBoundsFromMonday(mon);
    const startIso = isoFromDate(bounds.start);
    let label = formatPayWeekLabel(bounds);
    if (startIso === thisIso) label = `This week (${label})`;
    options.push({ startIso, label, isCurrent: startIso === thisIso });
  }
  return options;
}
