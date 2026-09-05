/**
 * WhenIsGood-style availability paint helpers (mirror web availability-paint.js).
 * Paint dense 30-min cells (9:00–23:00), project onto draft schedule slotKeys.
 */
import { WEEKDAY_KEYS, type WeekdayKey } from './schedule/types';

export const PAINT_START_MIN = 9 * 60;
export const PAINT_END_MIN = 23 * 60;
export const PAINT_STEP_MIN = 30;

export type PaintSlot = { start: string; end: string; slotKey: string };
export type PaintDay = Record<string, boolean>;
export type PaintGrid = Record<WeekdayKey, PaintDay>;
export type WeeklyGridNormalized = Record<WeekdayKey, Record<string, boolean>>;

function pad2(n: number) {
  return String(n).padStart(2, '0');
}

export function minsToHHMM(mins: number) {
  const m = ((mins % (24 * 60)) + 24 * 60) % (24 * 60);
  const h = Math.floor(m / 60);
  const mi = m % 60;
  return `${pad2(h)}:${pad2(mi)}`;
}

export function hhmmToMins(t: string) {
  const p = String(t || '').split(':');
  const h = parseInt(p[0], 10) || 0;
  const mi = parseInt(p[1], 10) || 0;
  return h * 60 + mi;
}

export function paintCellKeys(): string[] {
  const keys: string[] = [];
  for (let m = PAINT_START_MIN; m < PAINT_END_MIN; m += PAINT_STEP_MIN) {
    keys.push(minsToHHMM(m));
  }
  return keys;
}

export function emptyPaintGrid(): PaintGrid {
  const out = {} as PaintGrid;
  const cells = paintCellKeys();
  WEEKDAY_KEYS.forEach((wk) => {
    out[wk] = {};
    cells.forEach((ck) => {
      out[wk][ck] = false;
    });
  });
  return out;
}

function parseSlotKey(slotKey: string): PaintSlot | null {
  const parts = String(slotKey || '').split('|');
  if (parts.length < 2) return null;
  return { start: parts[0], end: parts[1], slotKey: `${parts[0]}|${parts[1]}` };
}

function normalizeSlot(slot: PaintSlot | { start: string; end: string; slotKey?: string } | null): PaintSlot | null {
  if (!slot) return null;
  if (slot.slotKey && slot.start && slot.end) {
    return { start: slot.start, end: slot.end, slotKey: slot.slotKey };
  }
  if ('slotKey' in slot && slot.slotKey) return parseSlotKey(slot.slotKey);
  if (slot.start && slot.end) {
    return { start: slot.start, end: slot.end, slotKey: `${slot.start}|${slot.end}` };
  }
  return null;
}

function slotIntervalMins(slot: PaintSlot) {
  let ss = hhmmToMins(slot.start);
  let se = hhmmToMins(slot.end);
  if (se <= ss) se += 24 * 60;
  return { start: ss, end: se };
}

export function cellsOverlappingSlot(slot: PaintSlot | { start: string; end: string; slotKey?: string }) {
  const s = normalizeSlot(slot);
  if (!s) return [] as string[];
  const iv = slotIntervalMins(s);
  const out: string[] = [];
  paintCellKeys().forEach((ck) => {
    const cs = hhmmToMins(ck);
    const ce = cs + PAINT_STEP_MIN;
    if (cs < iv.end && ce > iv.start) out.push(ck);
  });
  return out;
}

function cellOverlapsSlot(cellStartHHMM: string, slot: PaintSlot) {
  const iv = slotIntervalMins(slot);
  const cs = hhmmToMins(cellStartHHMM);
  const ce = cs + PAINT_STEP_MIN;
  return cs < iv.end && ce > iv.start;
}

function slotFullyPainted(paintDay: PaintDay | undefined, slot: PaintSlot) {
  const cells = cellsOverlappingSlot(slot);
  if (!cells.length) return false;
  const day = paintDay || {};
  return cells.every((ck) => !!day[ck]);
}

export function gridFromWeeklySlots(
  weeklyGrid: WeeklyGridNormalized | Record<string, Record<string, boolean>> | null | undefined,
  slots: Array<PaintSlot | { start: string; end: string; slotKey?: string }>
): PaintGrid {
  const paint = emptyPaintGrid();
  const list = (slots || []).map(normalizeSlot).filter(Boolean) as PaintSlot[];
  WEEKDAY_KEYS.forEach((wk) => {
    const day = (weeklyGrid && weeklyGrid[wk]) || {};
    list.forEach((slot) => {
      if (!day[slot.slotKey]) return;
      paintCellKeys().forEach((ck) => {
        if (cellOverlapsSlot(ck, slot)) paint[wk][ck] = true;
      });
    });
    Object.keys(day).forEach((sk) => {
      if (!day[sk]) return;
      const slot = parseSlotKey(sk);
      if (!slot) return;
      paintCellKeys().forEach((ck) => {
        if (cellOverlapsSlot(ck, slot)) paint[wk][ck] = true;
      });
    });
  });
  return paint;
}

export function projectPaintToWeeklyGrid(
  paintByDay: PaintGrid,
  slots: Array<PaintSlot | { start: string; end: string; slotKey?: string }>,
  baseGrid?: WeeklyGridNormalized | Record<string, Record<string, boolean>> | null
): WeeklyGridNormalized {
  const out = {} as WeeklyGridNormalized;
  WEEKDAY_KEYS.forEach((wk) => {
    out[wk] = {};
  });
  const list = (slots || []).map(normalizeSlot).filter(Boolean) as PaintSlot[];
  const seen: Record<string, PaintSlot> = {};
  list.forEach((slot) => {
    seen[slot.slotKey] = slot;
  });
  if (baseGrid) {
    WEEKDAY_KEYS.forEach((wk) => {
      Object.keys(baseGrid[wk] || {}).forEach((sk) => {
        if (!seen[sk]) {
          const p = parseSlotKey(sk);
          if (p) {
            seen[sk] = p;
            list.push(p);
          }
        }
      });
    });
  }
  WEEKDAY_KEYS.forEach((wk) => {
    const paintDay = paintByDay?.[wk] || {};
    list.forEach((slot) => {
      out[wk][slot.slotKey] = slotFullyPainted(paintDay, slot);
    });
  });
  return out;
}

export function formatPaintLabel(hhmm: string) {
  const mins = hhmmToMins(hhmm);
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const pm = h >= 12;
  let h12 = h % 12;
  if (h12 === 0) h12 = 12;
  if (m === 0) return `${h12}${pm ? 'p' : 'a'}`;
  return `${h12}:${pad2(m)}${pm ? 'p' : 'a'}`;
}

export function summarizeDayRanges(paintDay: PaintDay | undefined) {
  const day = paintDay || {};
  const cells = paintCellKeys();
  const ranges: string[] = [];
  let runStart: string | null = null;
  let runEnd: string | null = null;
  cells.forEach((ck) => {
    if (day[ck]) {
      if (runStart == null) runStart = ck;
      runEnd = minsToHHMM(hhmmToMins(ck) + PAINT_STEP_MIN);
    } else if (runStart != null) {
      ranges.push(`${formatPaintLabel(runStart)}–${formatPaintLabel(runEnd!)}`);
      runStart = null;
      runEnd = null;
    }
  });
  if (runStart != null && runEnd != null) {
    ranges.push(`${formatPaintLabel(runStart)}–${formatPaintLabel(runEnd)}`);
  }
  return ranges.join(', ');
}

export function paintAll(paintByDay: PaintGrid | null | undefined, on: boolean): PaintGrid {
  const paint = paintByDay ? (JSON.parse(JSON.stringify(paintByDay)) as PaintGrid) : emptyPaintGrid();
  const cells = paintCellKeys();
  WEEKDAY_KEYS.forEach((wk) => {
    cells.forEach((ck) => {
      paint[wk][ck] = !!on;
    });
  });
  return paint;
}

export function clearPaintDay(paintByDay: PaintGrid | null | undefined, wk: WeekdayKey): PaintGrid {
  const paint = paintByDay ? (JSON.parse(JSON.stringify(paintByDay)) as PaintGrid) : emptyPaintGrid();
  if (!paint[wk]) paint[wk] = {};
  paintCellKeys().forEach((ck) => {
    paint[wk][ck] = false;
  });
  return paint;
}
