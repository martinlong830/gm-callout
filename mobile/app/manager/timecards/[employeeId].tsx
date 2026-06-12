import { useFocusEffect, useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import { employeeDisplayName, type EmployeeRow } from '../../../lib/employees';
import { GrandTotalsSection } from '../../../components/timecards/GrandTotalsSection';
import {
  buildRosterRow,
  buildShiftsForEmployeeInWeek,
  computeRosterTotals,
  dailyRecordedMinutesForEmployee,
  decimalHoursFromMinutes,
  findEntriesForDay,
  formatDayBreakLabel,
  formatHourlyRateLabel,
  formatShiftPayLabel,
  roundToNearest5Minutes,
  scheduledPaidMinutes,
  shiftPayForScheduledRecorded,
  type RosterTotals,
  type ShiftDayRow,
} from '../../../lib/timecards/engine';
import { redPokeShiftTimeLabel } from '../../../lib/schedule/engine';
import type { EmployeeLite } from '../../../lib/schedule/types';
import type { TimeClockEntry } from '../../../lib/timecards/types';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

export default function TimecardsEmployeeScreen() {
  const { employeeId } = useLocalSearchParams<{ employeeId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { employees, staffRequests, teamState } = useAppData();
  const { entries, bounds, weekLabel } = useTimecards();

  const emp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  const lites = useMemo(() => employees.map(toLite), [employees]);
  const shifts = useMemo(
    () => (emp ? buildShiftsForEmployeeInWeek(emp, teamState, lites, bounds) : []),
    [emp, teamState, lites, bounds]
  );

  const [weekTotals, setWeekTotals] = useState<RosterTotals | null>(null);

  const loadWeekTotals = useCallback(async () => {
    if (!emp) return;
    const rosterRow = await buildRosterRow(emp, entries, teamState, staffRequests, lites, bounds);
    setWeekTotals(computeRosterTotals([rosterRow]));
  }, [emp, staffRequests, bounds, entries, teamState, lites]);

  useEffect(() => {
    void loadWeekTotals();
  }, [loadWeekTotals]);

  useFocusEffect(
    useCallback(() => {
      void loadWeekTotals();
    }, [loadWeekTotals])
  );

  useEffect(() => {
    if (emp) {
      navigation.setOptions({ title: employeeDisplayName(emp) });
    }
  }, [emp, navigation]);

  if (!emp) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Employee not found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.weekMeta}>Pay week: {weekLabel}</Text>
      {weekTotals ? (
        <GrandTotalsSection
          totals={weekTotals}
          bounds={bounds}
          showTipPool={false}
          metaLabel={`${employeeDisplayName(emp)} · week totals`}
          hourlyRateLabel={formatHourlyRateLabel(emp)}
        />
      ) : null}

      <Text style={styles.sectionTitle}>Shifts this pay week</Text>
      {!shifts.length ? (
        <Text style={styles.muted}>No scheduled shifts this pay week.</Text>
      ) : (
        shifts.map((row) => (
          <ShiftRowCard
            key={`${row.shift.restaurantId}-${row.shift.id}`}
            row={row}
            empId={emp.id}
            emp={emp}
            entries={entries}
            onPress={() =>
              router.push({
                pathname: '/manager/timecards/[employeeId]/shift',
                params: {
                  employeeId: emp.id,
                  shiftId: row.shift.id,
                  iso: row.iso,
                },
              })
            }
          />
        ))
      )}
    </ScrollView>
  );
}

function ShiftRowCard({
  row,
  empId,
  emp,
  entries,
  onPress,
}: {
  row: ShiftDayRow;
  empId: string;
  emp: EmployeeRow;
  entries: TimeClockEntry[];
  onPress: () => void;
}) {
  const s = row.shift;
  const dayEntries = findEntriesForDay(entries, empId, row.iso);
  const recMins = dailyRecordedMinutesForEmployee(entries, empId, row.iso);
  const breakLabel = formatDayBreakLabel(entries, empId, row.iso);
  const schedMins = scheduledPaidMinutes(s);
  const shiftPay = shiftPayForScheduledRecorded(emp, schedMins, recMins);
  const payLabel = formatShiftPayLabel(shiftPay);
  const rateLabel = formatHourlyRateLabel(emp);
  const when =
    (row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '') +
    s.day +
    ' · ' +
    (s.timeLabel || redPokeShiftTimeLabel(s.start, s.end));

  return (
    <Pressable style={styles.shiftCard} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.shiftWhen}>{when}</Text>
      </View>
      <Text style={styles.shiftMeta}>
        Sched {decimalHoursFromMinutes(scheduledPaidMinutes(s))}h · Rec{' '}
        {recMins ? decimalHoursFromMinutes(roundToNearest5Minutes(recMins)) + 'h' : '—'}
        {dayEntries.length > 1 ? ` · ${dayEntries.length} punches` : ''}
      </Text>
      <Text style={styles.shiftMeta}>Break {breakLabel}</Text>
      <Text style={styles.shiftPay}>Pay {payLabel} · Pay/hr {rateLabel}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 40 },
  weekMeta: { fontSize: 13, color: '#64748b', marginBottom: 10 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10, marginTop: 4, color: '#0f172a' },
  shiftCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    marginBottom: 8,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  shiftWhen: { fontSize: 15, fontWeight: '600', color: '#0f172a', flex: 1 },
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  shiftMeta: { fontSize: 13, color: '#64748b', marginTop: 6 },
  shiftPay: { fontSize: 13, fontWeight: '600', color: '#0f172a', marginTop: 4 },
  muted: { color: '#888', textAlign: 'center', marginTop: 20 },
});
