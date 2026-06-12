import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  compactShiftTimeLabel,
  formatCalendarDateLabel,
} from '../lib/schedule/employeeShiftDisplay';
import type { WorkerShiftRow } from '../lib/schedule/engine';

const ROLE_COLORS: Record<string, { bg: string; fg: string; border: string }> = {
  Kitchen: { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  Bartender: { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
  Server: { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
};

type Props = {
  row: WorkerShiftRow;
  selected?: boolean;
  onPress?: () => void;
};

export function CompactShiftRow({ row, selected, onPress }: Props) {
  const roleStyle = ROLE_COLORS[row.role] ?? ROLE_COLORS.Server;
  const dateLabel = formatCalendarDateLabel(row);
  const time = compactShiftTimeLabel(row);
  const breakNote = row.redPokeBreak ? String(row.redPokeBreak) : '';
  const hours = row.redPokeHours ? String(row.redPokeHours) : '';

  const inner = (
    <>
      <View style={styles.top}>
        <View style={[styles.pill, { backgroundColor: roleStyle.bg, borderColor: roleStyle.border }]}>
          <Text style={[styles.pillText, { color: roleStyle.fg }]} numberOfLines={1}>
            {row.groupLabel || row.role}
          </Text>
        </View>
        <Text style={styles.date} numberOfLines={1}>
          {dateLabel}
        </Text>
      </View>
      <Text style={styles.time}>{time}</Text>
      {breakNote ? <Text style={styles.sub}>{breakNote}</Text> : null}
      {hours ? <Text style={styles.sub}>{hours}</Text> : null}
      <Text style={styles.loc} numberOfLines={1}>
        {row.restaurantName}
      </Text>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        style={[styles.row, selected && styles.rowSelected]}
        onPress={onPress}
      >
        {inner}
      </Pressable>
    );
  }

  return <View style={[styles.row, selected && styles.rowSelected]}>{inner}</View>;
}

const styles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    backgroundColor: '#fafbfc',
  },
  rowSelected: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  pill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 6,
    borderWidth: 1,
    maxWidth: '48%',
  },
  pillText: { fontSize: 11, fontWeight: '700' },
  date: { fontSize: 12, fontWeight: '700', color: '#0f172a', flex: 1, textAlign: 'right' },
  time: { fontSize: 14, fontWeight: '600', color: '#111', marginTop: 6 },
  sub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  loc: { fontSize: 12, color: '#64748b', marginTop: 4 },
});
