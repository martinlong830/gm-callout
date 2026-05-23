import { getThisMondayDate } from '../schedule/engine';
import type { PayWeekBounds } from './types';

export function isoFromDate(dt: Date): string {
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

export function getPayWeekBounds(): PayWeekBounds {
  const mon = getThisMondayDate();
  const sunEnd = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 7);
  sunEnd.setMilliseconds(sunEnd.getMilliseconds() - 1);
  return { start: mon, end: sunEnd };
}

export function formatPayWeekLabel(bounds: PayWeekBounds): string {
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  const a = bounds.start.toLocaleDateString(undefined, opts);
  const b = bounds.end.toLocaleDateString(undefined, { ...opts, year: 'numeric' });
  return `${a} – ${b}`;
}

export function weekBoundsStorageKey(bounds: PayWeekBounds): string {
  return `${isoFromDate(bounds.start)}_${isoFromDate(bounds.end)}`;
}
