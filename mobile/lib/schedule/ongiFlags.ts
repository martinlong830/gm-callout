import type { RoleKey } from './types';

function normalizeMondayIso(iso: unknown): string {
  const s = String(iso || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

const ROLE_KEYS: RoleKey[] = ['Bartender', 'Kitchen', 'Server'];

export type OngiStoreId = 1 | 2 | 3;
/** mondayIso → restaurantId → "role|trIdx|dayIso" → store id or false (uncheck tombstone). */
export type OngiCellValue = OngiStoreId | false;
export type OngiFlagsByWeek = Record<string, Record<string, Record<string, OngiCellValue>>>;

export function ongiFlagCellKey(role: string, trIdx: number, dayIso: string): string {
  return `${role}|${Number(trIdx)}|${String(dayIso || '').slice(0, 10)}`;
}

function parseOngiFlagCellKey(
  key: string
): { role: RoleKey; trIdx: number; dayIso: string } | null {
  const m = String(key || '').match(/^(Bartender|Kitchen|Server)\|(\d+)\|(\d{4}-\d{2}-\d{2})$/);
  if (!m) return null;
  return { role: m[1] as RoleKey, trIdx: Number(m[2]), dayIso: m[3] };
}

/** Parse stored/UI value. Legacy `true` becomes Ongi 1. `false` is an explicit off tombstone. */
export function parseOngiStoreValue(val: unknown): OngiCellValue | null {
  if (val === false || val === 0 || val === '0' || val === 'false' || val === 'none' || val === '') {
    return false;
  }
  if (val === true || val === 'true') return 1;
  const n = Number(val);
  if (n === 1 || n === 2 || n === 3) return n;
  const s = String(val || '')
    .toLowerCase()
    .replace(/\s+/g, '');
  if (s === 'ongi1' || s === 'ongi-1') return 1;
  if (s === 'ongi2' || s === 'ongi-2') return 2;
  if (s === 'ongi3' || s === 'ongi-3') return 3;
  return null;
}

export function ongiStoreLabel(store: unknown, prefix = 'Ongi'): string {
  const n = parseOngiStoreValue(store);
  if (n !== 1 && n !== 2 && n !== 3) return '';
  return `${prefix} ${n}`;
}

export function sanitizeOngiFlagsByWeek(raw: unknown): OngiFlagsByWeek {
  if (!raw || typeof raw !== 'object') return {};
  const out: OngiFlagsByWeek = {};
  Object.keys(raw as Record<string, unknown>).forEach((weekKey) => {
    const mon = normalizeMondayIso(weekKey);
    if (!mon) return;
    const byRest = (raw as Record<string, unknown>)[weekKey];
    if (!byRest || typeof byRest !== 'object') return;
    const restOut: OngiFlagsByWeek[string] = {};
    Object.keys(byRest as Record<string, unknown>).forEach((rid) => {
      const cells = (byRest as Record<string, unknown>)[rid];
      if (!cells || typeof cells !== 'object') return;
      const cellOut: Record<string, OngiCellValue> = {};
      Object.keys(cells as Record<string, unknown>).forEach((cellKey) => {
        const parsed = parseOngiFlagCellKey(cellKey);
        if (!parsed) return;
        const flag = parseOngiStoreValue((cells as Record<string, unknown>)[cellKey]);
        if (flag == null) return;
        cellOut[ongiFlagCellKey(parsed.role, parsed.trIdx, parsed.dayIso)] = flag;
      });
      if (Object.keys(cellOut).length) restOut[rid] = cellOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

export function readOngiFlagsByWeek(draftRaw: unknown): OngiFlagsByWeek {
  if (!draftRaw || typeof draftRaw !== 'object') return {};
  return sanitizeOngiFlagsByWeek((draftRaw as { ongiFlagsByWeek?: unknown }).ongiFlagsByWeek);
}

/** Active Ongi store (1–3), or 0 if unset. */
export function getOngiFlag(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  role: string,
  trIdx: number,
  dayIso: string
): 0 | OngiStoreId {
  const mon = normalizeMondayIso(mondayIso);
  const rid = String(restaurantId || '');
  const iso = String(dayIso || '').slice(0, 10);
  if (!mon || !rid || !ROLE_KEYS.includes(role as RoleKey) || !iso) return 0;
  const week = readOngiFlagsByWeek(draftRaw)[mon];
  const rest = week?.[rid];
  const parsed = parseOngiStoreValue(rest?.[ongiFlagCellKey(role, trIdx, iso)]);
  return parsed === 1 || parsed === 2 || parsed === 3 ? parsed : 0;
}

export function mergeOngiFlagsByWeekMaps(
  localRaw: unknown,
  remoteRaw: unknown,
  preferWhenBoth: 'local' | 'remote' = 'remote'
): OngiFlagsByWeek {
  const local = sanitizeOngiFlagsByWeek(localRaw);
  const remote = sanitizeOngiFlagsByWeek(remoteRaw);
  const out: OngiFlagsByWeek = {};
  const weekKeys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  weekKeys.forEach((mon) => {
    const lRest = local[mon] || {};
    const rRest = remote[mon] || {};
    const restOut: OngiFlagsByWeek[string] = {};
    const rids = new Set([...Object.keys(lRest), ...Object.keys(rRest)]);
    rids.forEach((rid) => {
      const lCells = lRest[rid] || {};
      const rCells = rRest[rid] || {};
      const cellOut: Record<string, OngiCellValue> = {};
      const keys = new Set([...Object.keys(lCells), ...Object.keys(rCells)]);
      keys.forEach((cellKey) => {
        const lv = Object.prototype.hasOwnProperty.call(lCells, cellKey) ? lCells[cellKey] : null;
        const rv = Object.prototype.hasOwnProperty.call(rCells, cellKey) ? rCells[cellKey] : null;
        if (lv != null && rv != null) cellOut[cellKey] = preferWhenBoth === 'local' ? lv : rv;
        else if (lv != null) cellOut[cellKey] = lv;
        else if (rv != null) cellOut[cellKey] = rv;
      });
      if (Object.keys(cellOut).length) restOut[rid] = cellOut;
    });
    if (Object.keys(restOut).length) out[mon] = restOut;
  });
  return out;
}

function writeOngiMap(base: Record<string, unknown>, map: OngiFlagsByWeek): void {
  if (Object.keys(map).length) base.ongiFlagsByWeek = map;
  else delete base.ongiFlagsByWeek;
}

/** Set one cell store (1–3) or clear with 0/false. Returns a new draft_schedule payload. */
export function patchOngiFlagInDraft(
  draftRaw: unknown,
  mondayIso: string,
  restaurantId: string,
  role: string,
  trIdx: number,
  dayIso: string,
  store: unknown
): unknown {
  const mon = normalizeMondayIso(mondayIso);
  const rid = String(restaurantId || '');
  const iso = String(dayIso || '').slice(0, 10);
  if (!mon || !rid || !ROLE_KEYS.includes(role as RoleKey) || !iso) {
    return draftRaw ?? { v: 2, byWeek: {} };
  }
  const base: Record<string, unknown> =
    draftRaw && typeof draftRaw === 'object'
      ? (JSON.parse(JSON.stringify(draftRaw)) as Record<string, unknown>)
      : { v: 2, byWeek: {} };
  const map = readOngiFlagsByWeek(base);
  if (!map[mon]) map[mon] = {};
  if (!map[mon][rid]) map[mon][rid] = {};
  const parsed = parseOngiStoreValue(store);
  map[mon][rid][ongiFlagCellKey(role, trIdx, iso)] = parsed == null ? false : parsed;
  writeOngiMap(base, sanitizeOngiFlagsByWeek(map));
  if (!base.v) base.v = 2;
  return base;
}
