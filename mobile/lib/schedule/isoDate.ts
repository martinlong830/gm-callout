/** Local-calendar ISO date helpers — same rules as web `schedule-sync-v2.js`. */

export function isoAddDaysLocal(iso: string, days: number): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
}

export function isoDaySpanInclusive(fromIso: string, toIso: string): number {
  const a = String(fromIso || '').slice(0, 10);
  const b = String(toIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a) || !/^\d{4}-\d{2}-\d{2}$/.test(b) || a > b) return 0;
  let n = 1;
  let cur = a;
  while (cur < b) {
    cur = isoAddDaysLocal(cur, 1);
    if (!cur) break;
    n += 1;
    if (n > 400) break;
  }
  return n;
}
