/**
 * Weekly availability matrix — same shape as web `normalizeWeeklyGrid` + `renderAvailabilityCompactHtml`
 * (Mon–Sun columns, slot rows from draft or union fallback).
 */
import { draftTimeSlotFor, makeTimeSlot, slotCountForRole, WEEKDAY_KEYS } from './schedule/engine';
import type { DraftGrid, RoleKey, WeekdayKey } from './schedule/types';

export type TimeSlot = ReturnType<typeof makeTimeSlot>;

export type WeeklyGridNormalized = Record<WeekdayKey, Record<string, boolean>>;

export type MatrixCell =
  | { wk: WeekdayKey; type: 'off' }
  | { wk: WeekdayKey; type: 'slot'; tr: TimeSlot; available: boolean };

function asRoleKey(staffType: string): RoleKey | null {
  if (staffType === 'Kitchen' || staffType === 'Bartender' || staffType === 'Server') return staffType;
  return null;
}

/** Short label e.g. `10a–7:30p` — matches web `compactAvailabilityRangeLabel`. */
export function compactAvailabilityRangeLabel(tr: { start: string; end: string }): string {
  function piece(t: string): string {
    const p = String(t || '').split(':');
    const h = parseInt(p[0], 10) || 0;
    const m = parseInt(p[1], 10) || 0;
    const pm = h >= 12;
    let h12 = h % 12;
    if (h12 === 0) h12 = 12;
    if (m === 0) return `${h12}${pm ? 'p' : 'a'}`;
    return `${h12}:${String(m).padStart(2, '0')}${pm ? 'p' : 'a'}`;
  }
  return `${piece(tr.start)}–${piece(tr.end)}`;
}

export function buildAvailabilitySlotRangesUnion(draftRows: DraftGrid): TimeSlot[] {
  const u: Record<string, TimeSlot> = {};
  const roles: RoleKey[] = ['Bartender', 'Kitchen', 'Server'];
  for (const wk of WEEKDAY_KEYS) {
    for (const role of roles) {
      const n = slotCountForRole(draftRows, role);
      for (let i = 0; i < n; i += 1) {
        const tr = draftTimeSlotFor(draftRows, role, wk, i);
        if (!tr) continue;
        if (!u[tr.slotKey]) u[tr.slotKey] = tr;
      }
    }
  }
  return Object.values(u).sort((a, b) => {
    if (a.start !== b.start) return a.start.localeCompare(b.start);
    return a.end.localeCompare(b.end);
  });
}

export function normalizeWeeklyGrid(
  grid: unknown,
  staffType: string,
  draftRows: DraftGrid
): WeeklyGridNormalized {
  const role = asRoleKey(staffType);
  const base = {} as WeeklyGridNormalized;
  WEEKDAY_KEYS.forEach((wk) => {
    base[wk] = {};
  });

  if (role) {
    const c0 = slotCountForRole(draftRows, role);
    WEEKDAY_KEYS.forEach((wk) => {
      for (let ti = 0; ti < c0; ti += 1) {
        const tr0 = draftTimeSlotFor(draftRows, role, wk, ti);
        if (!tr0) continue;
        base[wk][tr0.slotKey] = true;
      }
    });
  } else {
    const slotList = buildAvailabilitySlotRangesUnion(draftRows);
    slotList.forEach((tr) => {
      WEEKDAY_KEYS.forEach((wk) => {
        base[wk][tr.slotKey] = true;
      });
    });
  }

  const g = grid && typeof grid === 'object' ? (grid as Record<string, Record<string, unknown>>) : null;
  if (!g) return base;

  if (role) {
    const c1 = slotCountForRole(draftRows, role);
    WEEKDAY_KEYS.forEach((wk) => {
      const day = g[wk];
      if (!day || typeof day !== 'object') return;
      for (let tj = 0; tj < c1; tj += 1) {
        const tr = draftTimeSlotFor(draftRows, role, wk, tj);
        if (!tr) continue;
        const sk = tr.slotKey;
        let v = day[sk];
        if (v === undefined) v = day[tr.start];
        base[wk][sk] = v === true;
      }
    });
  } else {
    const slotList = buildAvailabilitySlotRangesUnion(draftRows);
    slotList.forEach((tr) => {
      WEEKDAY_KEYS.forEach((wk) => {
        const day = g[wk];
        if (!day || typeof day !== 'object') return;
        const sk = tr.slotKey;
        let v = day[sk];
        if (v === undefined) v = day[tr.start];
        base[wk][sk] = v === true;
      });
    });
  }
  return base;
}

export function buildAvailabilityMatrixRows(
  staffType: string,
  draftRows: DraftGrid,
  normalized: WeeklyGridNormalized
): MatrixCell[][] {
  const role = asRoleKey(staffType);
  if (role) {
    const rowCount = slotCountForRole(draftRows, role);
    const rows: MatrixCell[][] = [];
    for (let trIdx = 0; trIdx < rowCount; trIdx += 1) {
      const row: MatrixCell[] = WEEKDAY_KEYS.map((wk) => {
        const tr = draftTimeSlotFor(draftRows, role, wk, trIdx);
        if (!tr) return { wk, type: 'off' };
        return { wk, type: 'slot', tr, available: !!normalized[wk][tr.slotKey] };
      });
      rows.push(row);
    }
    return rows;
  }
  const slotList = buildAvailabilitySlotRangesUnion(draftRows);
  return slotList.map((tr) =>
    WEEKDAY_KEYS.map((wk) => ({
      wk,
      type: 'slot' as const,
      tr,
      available: !!normalized[wk][tr.slotKey],
    }))
  );
}
