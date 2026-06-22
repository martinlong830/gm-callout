import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  formatScheduleWeekRangeLabel,
  formatWeekOfLabel,
  weekStartIsoFromIso,
} from '../lib/schedule/employeeShiftDisplay';
import type { WeekMeta } from '../lib/schedule/types';

type PagerProps = {
  mode: 'pager';
  weekMeta: WeekMeta[];
  /** Monday ISO strings for weeks that have shifts, in order. */
  weekStartIsos: string[];
  cursor: number;
  onCursorChange: (next: number) => void;
};

type ChipsProps = {
  mode: 'chips';
  weekMeta: WeekMeta[];
  weekIndices: number[];
  selectedWeekIndex: number;
  onSelectWeekIndex: (weekIndex: number) => void;
  currentWeekIndex?: number;
};

type ManagerNavProps = {
  mode: 'managerNav';
  weekMeta: WeekMeta[];
  weekIndex: number;
  onWeekIndexChange: (weekIndex: number) => void;
  minWeekIndex?: number;
  maxWeekIndex?: number;
  templateWeekIndex?: number;
};

type Props = PagerProps | ChipsProps | ManagerNavProps;

export function ScheduleWeekPicker(props: Props) {
  if (props.mode === 'managerNav') {
    const {
      weekMeta,
      weekIndex,
      onWeekIndexChange,
      minWeekIndex = 0,
      maxWeekIndex = weekMeta.length ? Math.floor((weekMeta.length - 1) / 7) : 0,
      templateWeekIndex,
    } = props;
    const isCurrent = templateWeekIndex != null && weekIndex === templateWeekIndex;
    const label = formatScheduleWeekRangeLabel(weekMeta, weekIndex);
    return (
      <View style={styles.managerNavWrap}>
        <Pressable
          style={[styles.navArrow, weekIndex <= minWeekIndex && styles.pagerBtnDisabled]}
          disabled={weekIndex <= minWeekIndex}
          onPress={() => onWeekIndexChange(weekIndex - 1)}
          accessibilityLabel="Previous week"
        >
          <Text style={styles.navArrowText}>‹</Text>
        </Pressable>
        <View style={styles.managerNavCenter}>
          <Text style={styles.managerNavLabel} numberOfLines={2}>
            {label}
          </Text>
          {isCurrent ? <Text style={styles.managerNavBadge}>This week</Text> : null}
        </View>
        <Pressable
          style={[styles.navArrow, weekIndex >= maxWeekIndex && styles.pagerBtnDisabled]}
          disabled={weekIndex >= maxWeekIndex}
          onPress={() => onWeekIndexChange(weekIndex + 1)}
          accessibilityLabel="Next week"
        >
          <Text style={styles.navArrowText}>›</Text>
        </Pressable>
        {!isCurrent && templateWeekIndex != null ? (
          <Pressable style={styles.todayBtn} onPress={() => onWeekIndexChange(templateWeekIndex)}>
            <Text style={styles.todayBtnText}>This week</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (props.mode === 'pager') {
    const { weekStartIsos, cursor, onCursorChange } = props;
    const wk = weekStartIsos[cursor];
    const label = wk ? formatWeekOfLabel(wk) : 'No upcoming shifts';
    return (
      <View style={styles.pager}>
        <Pressable
          style={[styles.pagerBtn, cursor <= 0 && styles.pagerBtnDisabled]}
          disabled={cursor <= 0}
          onPress={() => onCursorChange(cursor - 1)}
        >
          <Text style={styles.pagerBtnText}>Prev week</Text>
        </Pressable>
        <Text style={styles.pagerLabel} numberOfLines={2}>
          {label}
        </Text>
        <Pressable
          style={[
            styles.pagerBtn,
            cursor >= weekStartIsos.length - 1 && styles.pagerBtnDisabled,
          ]}
          disabled={cursor >= weekStartIsos.length - 1}
          onPress={() => onCursorChange(cursor + 1)}
        >
          <Text style={styles.pagerBtnText}>Next week</Text>
        </Pressable>
      </View>
    );
  }

  const { weekMeta, weekIndices, selectedWeekIndex, onSelectWeekIndex, currentWeekIndex } = props;
  if (!weekIndices.length) {
    return <Text style={styles.muted}>No weeks with shifts in this window.</Text>;
  }

  return (
    <View style={styles.chipsWrap}>
      <Text style={styles.chipsLabel}>Week</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} nestedScrollEnabled>
        <View style={styles.chipsRow}>
          {weekIndices.map((wi) => {
            const on = wi === selectedWeekIndex;
            const isCurrent = currentWeekIndex != null && wi === currentWeekIndex;
            return (
              <Pressable
                key={wi}
                style={[styles.chip, on && styles.chipOn]}
                onPress={() => onSelectWeekIndex(wi)}
              >
                <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={2}>
                  {formatScheduleWeekRangeLabel(weekMeta, wi)}
                  {isCurrent ? ' · This week' : ''}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

/** First week-start ISO for a given week index (for pager labels). */
export function weekStartIsoForIndex(weekMeta: WeekMeta[], weekIndex: number): string {
  const m = weekMeta.find((x) => x.weekIndex === weekIndex);
  return m ? weekStartIsoFromIso(m.iso) : '';
}

const styles = StyleSheet.create({
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    marginTop: 8,
    marginBottom: 4,
  },
  pagerBtn: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  pagerBtnDisabled: { opacity: 0.4 },
  pagerBtnText: { fontSize: 13, fontWeight: '600', color: '#334155' },
  pagerLabel: {
    flex: 1,
    textAlign: 'center',
    fontSize: 14,
    fontWeight: '700',
    color: '#0f172a',
    paddingHorizontal: 4,
  },
  chipsWrap: { marginBottom: 8 },
  chipsLabel: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6, textTransform: 'uppercase' },
  chipsRow: { flexDirection: 'row', gap: 8, paddingVertical: 2 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    maxWidth: 200,
  },
  chipOn: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  chipText: { fontSize: 12, color: '#475569', fontWeight: '600' },
  chipTextOn: { color: '#c41230' },
  muted: { fontSize: 13, color: '#888' },
  managerNavWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
  },
  navArrow: {
    width: 40,
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navArrowText: { fontSize: 22, fontWeight: '600', color: '#334155', lineHeight: 24 },
  managerNavCenter: { flex: 1, alignItems: 'center', minWidth: 120 },
  managerNavLabel: { fontSize: 14, fontWeight: '700', color: '#0f172a', textAlign: 'center' },
  managerNavBadge: {
    marginTop: 4,
    fontSize: 11,
    fontWeight: '700',
    color: '#c41230',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  todayBtn: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    backgroundColor: '#fff',
  },
  todayBtnText: { fontSize: 12, fontWeight: '600', color: '#334155' },
});
