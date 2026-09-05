import { useCallback, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useI18n } from '../contexts/LocaleContext';
import {
  clearPaintDay,
  formatPaintLabel,
  gridFromWeeklySlots,
  paintAll,
  paintCellKeys,
  projectPaintToWeeklyGrid,
  summarizeDayRanges,
  type PaintGrid,
} from '../lib/availabilityPaint';
import type { DraftGrid, WeekdayKey } from '../lib/schedule/types';
import { WEEKDAY_KEYS } from '../lib/schedule/engine';
import {
  listAvailabilitySlotsForStaffType,
  type WeeklyGridNormalized,
} from '../lib/weeklyAvailabilityMatrix';

const TIME_COL = 36;
const DAY_COL = 44;
const CELL_H = 16;

const WEEKDAY_I18N: Record<string, string> = {
  Mon: 'days.mon',
  Tue: 'days.tue',
  Wed: 'days.wed',
  Thu: 'days.thu',
  Fri: 'days.fri',
  Sat: 'days.sat',
  Sun: 'days.sun',
};

type Props = {
  staffType: string;
  draftRows: DraftGrid;
  normalized: WeeklyGridNormalized;
  onChange: (next: WeeklyGridNormalized) => void;
  onPaintGestureChange?: (active: boolean) => void;
  /** When remounting after Check all, start with every cell painted. */
  seedMode?: 'slots' | 'all';
};

function clonePaint(p: PaintGrid): PaintGrid {
  return JSON.parse(JSON.stringify(p)) as PaintGrid;
}

export function AvailabilityPaintGrid({
  staffType,
  draftRows,
  normalized,
  onChange,
  onPaintGestureChange,
  seedMode = 'slots',
}: Props) {
  const { t } = useI18n();
  const slots = useMemo(
    () => listAvailabilitySlotsForStaffType(staffType, draftRows),
    [staffType, draftRows]
  );
  const cellKeys = useMemo(() => paintCellKeys(), []);
  const [paint, setPaint] = useState<PaintGrid>(() =>
    seedMode === 'all' ? paintAll(null, true) : gridFromWeeklySlots(normalized, slots)
  );
  const paintRef = useRef(paint);
  paintRef.current = paint;

  const paintValueRef = useRef(true);
  const paintingRef = useRef(false);
  const gridOriginRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const bodyRef = useRef<View>(null);

  const emitChange = useCallback(
    (nextPaint: PaintGrid) => {
      paintRef.current = nextPaint;
      setPaint(nextPaint);
      onChange(projectPaintToWeeklyGrid(nextPaint, slots, normalized));
    },
    [onChange, slots, normalized]
  );

  const refreshOrigin = useCallback(() => {
    bodyRef.current?.measureInWindow((x, y, width, height) => {
      gridOriginRef.current = { x, y, width, height };
    });
  }, []);

  const applyCellAt = useCallback(
    (pageX: number, pageY: number) => {
      const origin = gridOriginRef.current;
      if (!origin.width || !origin.height) return;
      const x = pageX - origin.x;
      const y = pageY - origin.y;
      if (x < TIME_COL || y < 0) return;
      const dayIdx = Math.floor((x - TIME_COL) / DAY_COL);
      const rowIdx = Math.floor(y / CELL_H);
      if (dayIdx < 0 || dayIdx >= WEEKDAY_KEYS.length) return;
      if (rowIdx < 0 || rowIdx >= cellKeys.length) return;
      const wk = WEEKDAY_KEYS[dayIdx];
      const ck = cellKeys[rowIdx];
      const cur = paintRef.current;
      if (!!cur[wk]?.[ck] === paintValueRef.current) return;
      const next = clonePaint(cur);
      if (!next[wk]) next[wk] = {};
      next[wk][ck] = paintValueRef.current;
      paintRef.current = next;
      setPaint(next);
    },
    [cellKeys]
  );

  const finishStroke = useCallback(() => {
    if (!paintingRef.current) return;
    paintingRef.current = false;
    onPaintGestureChange?.(false);
    emitChange(paintRef.current);
  }, [emitChange, onPaintGestureChange]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: (ev) => {
          refreshOrigin();
          const { pageX, pageY } = ev.nativeEvent;
          const origin = gridOriginRef.current;
          const x = pageX - origin.x;
          const y = pageY - origin.y;
          const dayIdx = Math.floor((x - TIME_COL) / DAY_COL);
          const rowIdx = Math.floor(y / CELL_H);
          const wk = WEEKDAY_KEYS[dayIdx];
          const ck = cellKeys[rowIdx];
          paintingRef.current = true;
          onPaintGestureChange?.(true);
          if (wk && ck && paintRef.current[wk]) {
            paintValueRef.current = !paintRef.current[wk][ck];
          } else {
            paintValueRef.current = true;
          }
          applyCellAt(pageX, pageY);
        },
        onPanResponderMove: (ev) => {
          if (!paintingRef.current) return;
          applyCellAt(ev.nativeEvent.pageX, ev.nativeEvent.pageY);
        },
        onPanResponderRelease: () => finishStroke(),
        onPanResponderTerminate: () => finishStroke(),
      }),
    [applyCellAt, cellKeys, finishStroke, onPaintGestureChange, refreshOrigin]
  );

  function clearDay(wk: WeekdayKey) {
    emitChange(clearPaintDay(paintRef.current, wk));
  }

  return (
    <View style={styles.wrap}>
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
        <View style={styles.border}>
          <View style={styles.headRow}>
            <View style={[styles.corner, { width: TIME_COL }]} />
            {WEEKDAY_KEYS.map((wk) => {
              const summary = summarizeDayRanges(paint[wk]) || '—';
              return (
                <View key={wk} style={[styles.dayHead, { width: DAY_COL }]}>
                  <Text style={styles.dayDow}>{t(WEEKDAY_I18N[wk] || 'days.mon')}</Text>
                  <Text style={styles.daySum} numberOfLines={2}>
                    {summary}
                  </Text>
                  <Pressable
                    onPress={() => clearDay(wk)}
                    hitSlop={4}
                    accessibilityRole="button"
                    accessibilityLabel={`Clear ${wk}`}
                  >
                    <Text style={styles.clearDay}>Clear</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
          <View
            ref={bodyRef}
            style={styles.body}
            onLayout={refreshOrigin}
            {...panResponder.panHandlers}
            collapsable={false}
          >
            {cellKeys.map((ck, ri) => (
              <View key={ck} style={styles.row}>
                <View style={[styles.timeCell, { width: TIME_COL, height: CELL_H }]}>
                  <Text style={styles.timeText}>{formatPaintLabel(ck)}</Text>
                </View>
                {WEEKDAY_KEYS.map((wk) => {
                  const on = !!paint[wk]?.[ck];
                  return (
                    <View
                      key={`${wk}-${ck}`}
                      style={[
                        styles.cell,
                        { width: DAY_COL, height: CELL_H },
                        on ? styles.cellOn : styles.cellOff,
                        ri % 2 === 1 && !on ? styles.cellAlt : null,
                      ]}
                    />
                  );
                })}
              </View>
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

/** Paint every cell on, then project onto slot keys (mobile “Check all”). */
export function availabilityPaintCheckAll(
  staffType: string,
  draftRows: DraftGrid,
  base: WeeklyGridNormalized
): WeeklyGridNormalized {
  const slots = listAvailabilitySlotsForStaffType(staffType, draftRows);
  const allOn = paintAll(gridFromWeeklySlots(base, slots), true);
  return projectPaintToWeeklyGrid(allOn, slots, base);
}

const styles = StyleSheet.create({
  wrap: { marginTop: 8 },
  border: {
    borderWidth: 1,
    borderColor: '#e8eaef',
    borderRadius: 6,
    backgroundColor: '#fff',
    overflow: 'hidden',
    alignSelf: 'flex-start',
  },
  headRow: {
    flexDirection: 'row',
    backgroundColor: '#fafbfc',
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaef',
  },
  corner: { borderRightWidth: 1, borderRightColor: '#e8eaef' },
  dayHead: {
    paddingVertical: 6,
    paddingHorizontal: 2,
    alignItems: 'center',
    borderRightWidth: 1,
    borderRightColor: '#e8eaef',
  },
  dayDow: {
    fontSize: 11,
    fontWeight: '800',
    color: '#0f172a',
    letterSpacing: 0.3,
  },
  daySum: {
    fontSize: 8,
    color: '#64748b',
    textAlign: 'center',
    lineHeight: 10,
    marginTop: 2,
    minHeight: 20,
  },
  clearDay: {
    fontSize: 9,
    fontWeight: '700',
    color: '#c41230',
    marginTop: 2,
  },
  body: {},
  row: { flexDirection: 'row' },
  timeCell: {
    justifyContent: 'center',
    paddingLeft: 2,
    borderRightWidth: 1,
    borderRightColor: '#e8eaef',
    backgroundColor: '#fafbfc',
  },
  timeText: { fontSize: 8, fontWeight: '600', color: '#64748b' },
  cell: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderColor: '#e8eaef',
  },
  cellOn: { backgroundColor: '#22c55e' },
  cellOff: { backgroundColor: '#fff' },
  cellAlt: { backgroundColor: '#f8fafc' },
});
