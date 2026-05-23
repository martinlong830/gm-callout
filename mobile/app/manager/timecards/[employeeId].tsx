import { useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import { employeeDisplayName, type EmployeeRow } from '../../../lib/employees';
import { getPayWeekBounds } from '../../../lib/timecards/payWeek';
import {
  buildShiftsForEmployeeInWeek,
  computeSpreadOfHours,
  dailyRecordedMinutesForEmployee,
  decimalHoursFromMinutes,
  findEntriesForDay,
  formatDayBreakLabel,
  formatHourlyRateLabel,
  formatPayAmount,
  formatShiftPayLabel,
  formatSoHDatesList,
  getEmployeeWeekExtras,
  payFromRegOtMinutes,
  roundToNearest5Minutes,
  scheduledPaidMinutes,
  setEmployeeWeekExtras,
  shiftPayForScheduledRecorded,
  shiftRegularOvertimeMinutes,
  shiftStatusLabelForDay,
  statusColor,
  type ShiftDayRow,
  type WeekExtras,
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
  const { entries, refresh } = useTimecards();

  const emp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  const lites = useMemo(() => employees.map(toLite), [employees]);
  const shifts = useMemo(
    () => (emp ? buildShiftsForEmployeeInWeek(emp, teamState, lites) : []),
    [emp, teamState, lites]
  );

  const [extras, setExtras] = useState<WeekExtras>({ vl: 0, sl: 0, manual: false });
  const [vlText, setVlText] = useState('0');
  const [slText, setSlText] = useState('0');

  const loadExtras = useCallback(async () => {
    if (!emp) return;
    const name = employeeDisplayName(emp);
    const schedByDay: Record<string, number> = {};
    for (const row of shifts) {
      if (!row.iso) continue;
      schedByDay[row.iso] = (schedByDay[row.iso] || 0) + scheduledPaidMinutes(row.shift);
    }
    const ex = await getEmployeeWeekExtras(
      emp,
      name,
      getPayWeekBounds(),
      staffRequests,
      schedByDay
    );
    setExtras(ex);
    setVlText(String(ex.vl));
    setSlText(String(ex.sl));
  }, [emp, shifts, staffRequests]);

  useEffect(() => {
    void loadExtras();
  }, [loadExtras]);

  useEffect(() => {
    if (emp) {
      navigation.setOptions({ title: employeeDisplayName(emp) });
    }
  }, [emp, navigation]);

  const weekPay = useMemo(() => {
    if (!emp) return { regPay: null, otPay: null, totalPay: null };
    let regMins = 0;
    let otMins = 0;
    for (const row of shifts) {
      const sched = scheduledPaidMinutes(row.shift);
      const rec = dailyRecordedMinutesForEmployee(entries, emp.id, row.iso);
      if (rec > 0) {
        const split = shiftRegularOvertimeMinutes(sched, rec);
        regMins += split.regMins;
        otMins += split.otMins;
      }
    }
    return payFromRegOtMinutes(emp, regMins, otMins);
  }, [shifts, entries, emp]);

  if (!emp) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Employee not found.</Text>
      </View>
    );
  }

  const soh = computeSpreadOfHours(emp, entries);

  const persistExtras = async () => {
    const vl = Math.max(0, parseFloat(vlText) || 0);
    const sl = Math.max(0, parseFloat(slText) || 0);
    await setEmployeeWeekExtras(emp.id, vl, sl, getPayWeekBounds());
    setExtras({ vl, sl, manual: true });
    await refresh();
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>VL / SL & SoH (this week)</Text>
        <Text style={styles.label}>VL (hrs)</Text>
        <TextInput style={styles.input} value={vlText} onChangeText={setVlText} keyboardType="decimal-pad" />
        <Text style={styles.label}>SL (hrs)</Text>
        <TextInput style={styles.input} value={slText} onChangeText={setSlText} keyboardType="decimal-pad" />
        <Pressable style={styles.btnSecondary} onPress={() => void persistExtras()}>
          <Text style={styles.btnSecondaryText}>Save VL/SL</Text>
        </Pressable>
        <Text style={styles.meta}>
          SoH: {soh.count} · {formatSoHDatesList(soh.dates)} ·{' '}
          {soh.hasRate ? formatPayAmount(soh.pay) : '—'}
        </Text>
        <Text style={styles.meta}>
          Reg {formatPayAmount(weekPay.regPay)} · OT {formatPayAmount(weekPay.otPay)} · Shift pay{' '}
          {formatPayAmount(weekPay.totalPay)} · Pay/hr {formatHourlyRateLabel(emp)}
        </Text>
        {!extras.manual ? (
          <Text style={styles.hint}>VL/SL from approved time off unless you save overrides.</Text>
        ) : null}
      </View>

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
  const st = shiftStatusLabelForDay(s, empId, row.iso, entries);
  const sc = statusColor(st);
  const when =
    (row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '') +
    s.day +
    ' · ' +
    (s.timeLabel || redPokeShiftTimeLabel(s.start, s.end));

  return (
    <Pressable style={styles.shiftCard} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.shiftWhen}>{when}</Text>
        <View style={[styles.badge, { backgroundColor: sc.bg }]}>
          <Text style={[styles.badgeText, { color: sc.text }]}>{st}</Text>
        </View>
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
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    marginBottom: 16,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#64748b', marginBottom: 10, textTransform: 'uppercase' },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    backgroundColor: '#fff',
    fontSize: 16,
  },
  btnSecondary: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 8,
    backgroundColor: '#fff',
  },
  btnSecondaryText: { fontWeight: '700', color: '#334155' },
  meta: { fontSize: 13, color: '#475569', marginTop: 4 },
  hint: { fontSize: 12, color: '#888', marginTop: 6 },
  sectionTitle: { fontSize: 16, fontWeight: '700', marginBottom: 10, color: '#0f172a' },
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
