import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { DraftGrid, WeekdayKey } from '../lib/schedule/types';
import { WEEKDAY_KEYS } from '../lib/schedule/engine';
import {
  buildAvailabilityMatrixRows,
  compactAvailabilityRangeLabel,
  type WeeklyGridNormalized,
} from '../lib/weeklyAvailabilityMatrix';

const COL = 56;
const SLOT_ROW_MIN_H = 54;

function cloneGrid(g: WeeklyGridNormalized): WeeklyGridNormalized {
  return JSON.parse(JSON.stringify(g)) as WeeklyGridNormalized;
}

type Props = {
  staffType: string;
  draftRows: DraftGrid;
  normalized: WeeklyGridNormalized;
  onChange: (next: WeeklyGridNormalized) => void;
  embedInParentScroll?: boolean;
};

export function AvailabilityMatrixEditor({
  staffType,
  draftRows,
  normalized,
  onChange,
  embedInParentScroll,
}: Props) {
  const rows = buildAvailabilityMatrixRows(staffType, draftRows, normalized);

  function toggle(wk: WeekdayKey, slotKey: string) {
    const next = cloneGrid(normalized);
    if (!next[wk]) next[wk] = {};
    next[wk][slotKey] = !next[wk][slotKey];
    onChange(next);
  }

  const table = (
    <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={styles.horiz}>
      <View style={styles.border}>
        <View style={[styles.tr, styles.headRow]}>
          {WEEKDAY_KEYS.map((wk) => (
            <View key={wk} style={[styles.th, { width: COL }]}>
              <Text style={styles.thText}>{wk}</Text>
            </View>
          ))}
        </View>
        {rows.map((cells, ri) => (
          <View key={ri} style={[styles.tr, ri % 2 === 1 ? styles.trAlt : undefined]}>
            {cells.map((cell, ci) => {
              if (cell.type === 'off') {
                return (
                  <View
                    key={`${cell.wk}-${ci}`}
                    style={[
                      styles.tdOff,
                      { width: COL, minHeight: SLOT_ROW_MIN_H },
                      ri % 2 === 1 && styles.tdOffAlt,
                    ]}
                  >
                    <Text style={styles.offMark}>—</Text>
                  </View>
                );
              }
              const on = !!normalized[cell.wk]?.[cell.tr.slotKey];
              return (
                <Pressable
                  key={`${cell.wk}-${cell.tr.slotKey}-${ci}`}
                  style={[
                    styles.td,
                    { width: COL, minHeight: SLOT_ROW_MIN_H },
                    ri % 2 === 1 && styles.tdAlt,
                  ]}
                  onPress={() => toggle(cell.wk, cell.tr.slotKey)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                >
                  <View style={styles.stack}>
                    <Text style={styles.time} numberOfLines={1} ellipsizeMode="tail">
                      {compactAvailabilityRangeLabel(cell.tr)}
                    </Text>
                    <View style={[styles.checkVisual, on ? styles.checkOn : styles.checkOff]}>
                      {on ? <Text style={styles.checkMark}>✓</Text> : null}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  );

  if (embedInParentScroll) {
    return <View style={styles.wrapEmbedded}>{table}</View>;
  }

  return <ScrollView style={styles.vert} nestedScrollEnabled showsVerticalScrollIndicator>{table}</ScrollView>;
}

/** Set every slot cell to available (web “Check all”). */
export function availabilityCheckAll(
  staffType: string,
  draftRows: DraftGrid,
  base: WeeklyGridNormalized
): WeeklyGridNormalized {
  const next = cloneGrid(base);
  const rows = buildAvailabilityMatrixRows(staffType, draftRows, next);
  rows.forEach((row) => {
    row.forEach((cell) => {
      if (cell.type !== 'slot') return;
      const { wk, tr } = cell;
      if (!next[wk]) next[wk] = {};
      next[wk][tr.slotKey] = true;
    });
  });
  return next;
}

const styles = StyleSheet.create({
  vert: { marginTop: 8 },
  wrapEmbedded: { marginTop: 8 },
  horiz: {},
  border: {
    borderWidth: 1,
    borderColor: '#e8eaef',
    borderRadius: 6,
    backgroundColor: '#fff',
    overflow: 'hidden',
  },
  tr: { flexDirection: 'row' },
  headRow: { backgroundColor: '#fafbfc', borderBottomWidth: 1, borderBottomColor: '#e8eaef' },
  th: { paddingVertical: 8, paddingHorizontal: 4, alignItems: 'center', justifyContent: 'flex-end' },
  thText: { fontSize: 11, fontWeight: '800', color: '#0f172a', letterSpacing: 0.4 },
  trAlt: {},
  td: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8eaef',
    paddingHorizontal: 4,
    paddingVertical: 4,
    backgroundColor: '#fff',
  },
  tdAlt: { backgroundColor: '#fafbfc' },
  tdOff: {
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8eaef',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#f8fafc',
  },
  tdOffAlt: { backgroundColor: '#f1f5f9' },
  offMark: { fontSize: 14, color: '#94a3b8', opacity: 0.65 },
  stack: {
    flex: 1,
    width: '100%',
    minHeight: SLOT_ROW_MIN_H - 12,
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 2,
  },
  time: {
    fontSize: 9,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
    lineHeight: 12,
    width: '100%',
  },
  checkVisual: {
    width: 20,
    height: 20,
    borderRadius: 3,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkOn: { backgroundColor: '#ecfdf5', borderColor: '#22c55e' },
  checkOff: { backgroundColor: '#f8fafc', borderColor: '#e2e8f0' },
  checkMark: {
    fontSize: 13,
    fontWeight: '800',
    color: '#15803d',
    lineHeight: 16,
    marginTop: -1,
  },
});
