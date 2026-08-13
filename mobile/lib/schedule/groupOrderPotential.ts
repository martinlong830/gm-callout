import { normalizeMondayIso } from './slotOrder';

export const GROUP_ORDER_POTENTIAL_PLATFORMS = [
  { id: 'sharebits', label: 'Sharebits' },
  { id: 'doordash', label: 'DoorDash' },
  { id: 'grubhub', label: 'Grubhub' },
  { id: 'uber', label: 'Uber' },
] as const;

export type GroupOrderPlatformId = (typeof GROUP_ORDER_POTENTIAL_PLATFORMS)[number]['id'];

/** mondayIso → restaurantId → platformId → dayIso → text */
export type GroupOrderPotentialByWeek = Record<
  string,
  Record<string, Partial<Record<GroupOrderPlatformId, Record<string, string>>>>
>;

const PLATFORM_IDS: GroupOrderPlatformId[] = GROUP_ORDER_POTENTIAL_PLATFORMS.map((p) => p.id);

export function sanitizeGroupOrderPotentialByWeek(raw: unknown): GroupOrderPotentialByWeek {
  if (!raw || typeof raw !== 'object') return {};
  const out: GroupOrderPotentialByWeek = {};
  Object.keys(raw as Record<string, unknown>).forEach((weekKey) => {
    const mon = normalizeMondayIso(weekKey);
    if (!mon) return;
    const byRest = (raw as Record<string, unknown>)[weekKey];
    if (!byRest || typeof byRest !== 'object') return;
    const restOut: GroupOrderPotentialByWeek[string] = {};
    Object.keys(byRest as Record<string, unknown>).forEach((rid) => {
      const byPlat = (byRest as Record<string, unknown>)[rid];
      if (!byPlat || typeof byPlat !== 'object') return;
      const platOut: Partial<Record<GroupOrderPlatformId, Record<string, string>>> = {};
      PLATFORM_IDS.forEach((pid) => {
        const days = (byPlat as Record<string, unknown>)[pid];
        if (!days || typeof days !== 'object') return;
        const dayOut: Record<string, string> = {};
        Object.keys(days as Record<string, unknown>).forEach((dayKey) => {
          const iso = String(dayKey || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
          const val = (days as Record<string, unknown>)[dayKey];
          if (val == null) return;
          const s = String(val).trim();
          if (!s) return;
          dayOut[iso] = s.slice(0, 80);
        });
        if (Object.keys(dayOut).length) platOut[pid] = dayOut;
      });
      if (Object.keys(platOut).length) restOut[rid] = platOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

export function readGroupOrderPotentialByWeek(draftRaw: unknown): GroupOrderPotentialByWeek {
  if (!draftRaw || typeof draftRaw !== 'object') return {};
  return sanitizeGroupOrderPotentialByWeek(
    (draftRaw as { groupOrderPotentialByWeek?: unknown }).groupOrderPotentialByWeek
  );
}

export function getGroupOrderPotentialCell(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  platformId: string,
  dayIso: string
): string {
  const mon = normalizeMondayIso(mondayIso);
  const iso = String(dayIso || '').slice(0, 10);
  if (!mon || !restaurantId || !platformId || !iso) return '';
  const week = readGroupOrderPotentialByWeek(draftRaw)[mon];
  const rest = week?.[restaurantId];
  const plat = rest?.[platformId as GroupOrderPlatformId];
  const val = plat?.[iso];
  return val != null ? String(val) : '';
}

export function mergeGroupOrderPotentialByWeekMaps(
  localRaw: unknown,
  remoteRaw: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): GroupOrderPotentialByWeek {
  const local = sanitizeGroupOrderPotentialByWeek(localRaw);
  const remote = sanitizeGroupOrderPotentialByWeek(remoteRaw);
  const out: GroupOrderPotentialByWeek = {};
  const weekKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  weekKeys.forEach((mon) => {
    const lRest = local[mon] || {};
    const rRest = remote[mon] || {};
    const restOut: GroupOrderPotentialByWeek[string] = {};
    const rids = new Set([...Object.keys(lRest), ...Object.keys(rRest)]);
    rids.forEach((rid) => {
      const lPlat = lRest[rid] || {};
      const rPlat = rRest[rid] || {};
      const platOut: Partial<Record<GroupOrderPlatformId, Record<string, string>>> = {};
      PLATFORM_IDS.forEach((pid) => {
        const lDays = lPlat[pid] || {};
        const rDays = rPlat[pid] || {};
        const dayKeys = new Set([...Object.keys(lDays), ...Object.keys(rDays)]);
        const dayOut: Record<string, string> = {};
        dayKeys.forEach((iso) => {
          const lv = lDays[iso] != null ? String(lDays[iso]).trim() : '';
          const rv = rDays[iso] != null ? String(rDays[iso]).trim() : '';
          if (lv && rv) dayOut[iso] = preferWhenBoth === 'local' ? lv : rv;
          else if (lv) dayOut[iso] = lv;
          else if (rv) dayOut[iso] = rv;
        });
        if (Object.keys(dayOut).length) platOut[pid] = dayOut;
      });
      if (Object.keys(platOut).length) restOut[rid] = platOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

function writeGroupOrderMap(base: Record<string, unknown>, map: GroupOrderPotentialByWeek): void {
  if (Object.keys(map).length) base.groupOrderPotentialByWeek = map;
  else delete base.groupOrderPotentialByWeek;
}

/** Set one cell and return a new draft_schedule payload. */
export function patchGroupOrderPotentialInDraft(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  platformId: GroupOrderPlatformId | string,
  dayIso: string,
  value: string
): unknown {
  const mon = normalizeMondayIso(mondayIso);
  const iso = String(dayIso || '').slice(0, 10);
  const rid = String(restaurantId || '');
  const pid = String(platformId || '') as GroupOrderPlatformId;
  if (!mon || !rid || !PLATFORM_IDS.includes(pid) || !iso) {
    return draftRaw ?? { v: 2, byWeek: {} };
  }
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  const map = readGroupOrderPotentialByWeek(base);
  if (!map[mon]) map[mon] = {};
  if (!map[mon][rid]) map[mon][rid] = {};
  if (!map[mon][rid][pid]) map[mon][rid][pid] = {};
  const s = String(value || '').trim().slice(0, 80);
  if (!s) {
    delete map[mon][rid][pid]![iso];
    if (!Object.keys(map[mon][rid][pid] || {}).length) delete map[mon][rid][pid];
    if (!Object.keys(map[mon][rid] || {}).length) delete map[mon][rid];
    if (!Object.keys(map[mon] || {}).length) delete map[mon];
  } else {
    map[mon][rid][pid]![iso] = s;
  }
  writeGroupOrderMap(base, sanitizeGroupOrderPotentialByWeek(map));
  if (!base.v) base.v = 2;
  return base;
}

export function mergeGroupOrderIntoDraft(
  draftRaw: unknown,
  localMap: unknown,
  remoteMap: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): unknown {
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  writeGroupOrderMap(base, mergeGroupOrderPotentialByWeekMaps(localMap, remoteMap, preferWhenBoth));
  if (!base.v) base.v = 2;
  return base;
}
