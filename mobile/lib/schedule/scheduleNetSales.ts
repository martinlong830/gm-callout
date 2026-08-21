import { normalizeMondayIso } from './slotOrder';

/** mondayIso → restaurantId → dayIso → numeric string */
export type ScheduleNetSalesByWeek = Record<string, Record<string, Record<string, string>>>;

export function sanitizeScheduleNetSalesByWeek(raw: unknown): ScheduleNetSalesByWeek {
  if (!raw || typeof raw !== 'object') return {};
  const out: ScheduleNetSalesByWeek = {};
  Object.keys(raw as Record<string, unknown>).forEach((weekKey) => {
    const mon = normalizeMondayIso(weekKey);
    if (!mon) return;
    const byRest = (raw as Record<string, unknown>)[weekKey];
    if (!byRest || typeof byRest !== 'object') return;
    const restOut: ScheduleNetSalesByWeek[string] = {};
    Object.keys(byRest as Record<string, unknown>).forEach((rid) => {
      const days = (byRest as Record<string, unknown>)[rid];
      if (!days || typeof days !== 'object') return;
      const dayOut: Record<string, string> = {};
      Object.keys(days as Record<string, unknown>).forEach((dayKey) => {
        const iso = String(dayKey || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
        const val = (days as Record<string, unknown>)[dayKey];
        if (val == null) return;
        const s = String(val).trim();
        if (!s) return;
        const n = Number(s.replace(/[$,\s]/g, ''));
        if (!Number.isFinite(n) || n < 0) return;
        dayOut[iso] = String(Math.round(n * 100) / 100);
      });
      if (Object.keys(dayOut).length) restOut[rid] = dayOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

export function readScheduleNetSalesByWeek(draftRaw: unknown): ScheduleNetSalesByWeek {
  if (!draftRaw || typeof draftRaw !== 'object') return {};
  return sanitizeScheduleNetSalesByWeek(
    (draftRaw as { scheduleNetSalesByWeek?: unknown }).scheduleNetSalesByWeek
  );
}

export function getScheduleNetSalesCell(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  dayIso: string
): string {
  const mon = normalizeMondayIso(mondayIso);
  const iso = String(dayIso || '').slice(0, 10);
  if (!mon || !restaurantId || !iso) return '';
  const week = readScheduleNetSalesByWeek(draftRaw)[mon];
  const rest = week?.[restaurantId];
  const val = rest?.[iso];
  return val != null ? String(val) : '';
}

export function mergeScheduleNetSalesByWeekMaps(
  localRaw: unknown,
  remoteRaw: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): ScheduleNetSalesByWeek {
  const local = sanitizeScheduleNetSalesByWeek(localRaw);
  const remote = sanitizeScheduleNetSalesByWeek(remoteRaw);
  const out: ScheduleNetSalesByWeek = {};
  const weekKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  weekKeys.forEach((mon) => {
    const lRest = local[mon] || {};
    const rRest = remote[mon] || {};
    const restOut: ScheduleNetSalesByWeek[string] = {};
    const rids = new Set([...Object.keys(lRest), ...Object.keys(rRest)]);
    rids.forEach((rid) => {
      const lDays = lRest[rid] || {};
      const rDays = rRest[rid] || {};
      const dayKeys = new Set([...Object.keys(lDays), ...Object.keys(rDays)]);
      const dayOut: Record<string, string> = {};
      dayKeys.forEach((iso) => {
        const lv = lDays[iso] != null ? String(lDays[iso]).trim() : '';
        const rv = rDays[iso] != null ? String(rDays[iso]).trim() : '';
        if (lv && rv) dayOut[iso] = preferWhenBoth === 'local' ? lv : rv;
        else if (lv) dayOut[iso] = lv;
        else if (rv) dayOut[iso] = rv;
      });
      if (Object.keys(dayOut).length) restOut[rid] = dayOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

function writeNetSalesMap(base: Record<string, unknown>, map: ScheduleNetSalesByWeek): void {
  if (Object.keys(map).length) base.scheduleNetSalesByWeek = map;
  else delete base.scheduleNetSalesByWeek;
}

export function patchScheduleNetSalesInDraft(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  dayIso: string,
  value: string
): unknown {
  const mon = normalizeMondayIso(mondayIso);
  const iso = String(dayIso || '').slice(0, 10);
  const rid = String(restaurantId || '');
  if (!mon || !rid || !iso) {
    return draftRaw ?? { v: 2, byWeek: {} };
  }
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  const map = readScheduleNetSalesByWeek(base);
  if (!map[mon]) map[mon] = {};
  if (!map[mon][rid]) map[mon][rid] = {};
  const cleaned = String(value || '')
    .trim()
    .replace(/[$,\s]/g, '');
  const n = cleaned === '' ? NaN : Number(cleaned);
  if (!Number.isFinite(n) || n < 0) {
    delete map[mon][rid][iso];
    if (!Object.keys(map[mon][rid] || {}).length) delete map[mon][rid];
    if (!Object.keys(map[mon] || {}).length) delete map[mon];
  } else {
    map[mon][rid][iso] = String(Math.round(n * 100) / 100);
  }
  writeNetSalesMap(base, sanitizeScheduleNetSalesByWeek(map));
  if (!base.v) base.v = 2;
  return base;
}

export function mergeNetSalesIntoDraft(
  draftRaw: unknown,
  localMap: unknown,
  remoteMap: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): unknown {
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  writeNetSalesMap(base, mergeScheduleNetSalesByWeekMaps(localMap, remoteMap, preferWhenBoth));
  if (!base.v) base.v = 2;
  return base;
}
