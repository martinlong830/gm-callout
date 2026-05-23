import { useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { DateTimePickerField } from '../../../../components/DateTimePickerField';
import { useAppData } from '../../../../contexts/AppDataContext';
import { useTimecards } from '../../../../contexts/TimecardsContext';
import { type EmployeeRow } from '../../../../lib/employees';
import { saveManagerPunch } from '../../../../lib/timecards/entriesApi';
import {
  buildShiftsForEmployeeInWeek,
  dailyRecordedMinutesForEmployee,
  decimalHoursFromMinutes,
  findEntriesForDay,
  breakMinutesFromRange,
  formatBreakRangeLabel,
  formatHistoryLines,
  formatHourlyRateLabel,
  formatPayAmount,
  formatPunchClock,
  formatShiftPayLabel,
  isEntryOpen,
  normalizePunchTimesForShift,
  parseBreakMinutesFromAnnotation,
  recordedPaidMinutes,
  roundToNearest5Minutes,
  scheduledPaidMinutes,
  shiftPayForScheduledRecorded,
  type ShiftDayRow,
} from '../../../../lib/timecards/engine';
import { dateToIso, parseIsoToDate } from '../../../../lib/timecards/punch';
import { redPokeShiftTimeLabel } from '../../../../lib/schedule/engine';
import type { EmployeeLite } from '../../../../lib/schedule/types';
import type { TimeClockEntry } from '../../../../lib/timecards/types';
import { supabase } from '../../../../lib/supabase';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

export default function TimecardsShiftScreen() {
  const { employeeId, shiftId, iso } = useLocalSearchParams<{
    employeeId: string;
    shiftId: string;
    iso: string;
  }>();
  const navigation = useNavigation();
  const { employees, teamState } = useAppData();
  const { entries, schema, refresh } = useTimecards();

  const emp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );
  const lites = useMemo(() => employees.map(toLite), [employees]);

  const shiftRow = useMemo((): ShiftDayRow | null => {
    if (!emp) return null;
    const rows = buildShiftsForEmployeeInWeek(emp, teamState, lites);
    return rows.find((r) => r.shift.id === shiftId && r.iso === iso) ?? null;
  }, [emp, teamState, lites, shiftId, iso]);

  const dayEntries = useMemo(
    () => (emp && iso ? findEntriesForDay(entries, emp.id, iso) : []),
    [emp, entries, iso]
  );

  const [entryId, setEntryId] = useState<string | null>(null);
  const [clockInDate, setClockInDate] = useState<Date | null>(null);
  const [clockOutDate, setClockOutDate] = useState<Date | null>(null);
  const [breakStartDate, setBreakStartDate] = useState<Date | null>(null);
  const [breakEndDate, setBreakEndDate] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);

  const loadEntry = useCallback((entry: TimeClockEntry | null) => {
    setEntryId(entry?.id ?? null);
    setClockInDate(parseIsoToDate(entry?.clock_in_at));
    setClockOutDate(parseIsoToDate(entry?.clock_out_at));
    setBreakStartDate(parseIsoToDate(entry?.break_start_at));
    setBreakEndDate(parseIsoToDate(entry?.break_end_at));
  }, []);

  useEffect(() => {
    if (!shiftRow || !emp) return;
    const s = shiftRow.shift;
    navigation.setOptions({
      title: s.day + ' · ' + (s.timeLabel || redPokeShiftTimeLabel(s.start, s.end)),
    });
    const open = dayEntries.filter(isEntryOpen);
    const pick = open.length ? open[open.length - 1] : dayEntries[dayEntries.length - 1] ?? null;
    loadEntry(pick);
  }, [shiftRow, emp, dayEntries, navigation, loadEntry]);

  const editingEntry = useMemo(
    () => (entryId ? dayEntries.find((e) => e.id === entryId) ?? null : null),
    [entryId, dayEntries]
  );

  const previewPaid = useMemo(() => {
    const inIso = dateToIso(clockInDate);
    if (!inIso) return null;
    const breakStartIso = dateToIso(breakStartDate);
    const breakEndIso = dateToIso(breakEndDate);
    const fake: TimeClockEntry = {
      id: '',
      employee_id: emp?.id ?? '',
      clock_in_at: inIso,
      clock_out_at: dateToIso(clockOutDate),
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      break_minutes: 0,
    };
    return recordedPaidMinutes(fake, shiftRow);
  }, [clockInDate, clockOutDate, breakStartDate, breakEndDate, emp, shiftRow]);

  const save = async () => {
    if (!emp || !shiftRow || !supabase) return;
    let inIso = dateToIso(clockInDate);
    let outIso = dateToIso(clockOutDate);
    const breakStartIso = dateToIso(breakStartDate);
    const breakEndIso = dateToIso(breakEndDate);
    if (!inIso) {
      Alert.alert('Timecard', 'Set clock in time.');
      return;
    }
    const nowTs = new Date();
    if (new Date(inIso).getTime() > nowTs.getTime()) {
      Alert.alert('Timecard', 'Clock in cannot be in the future.');
      return;
    }
    if (breakEndIso && !breakStartIso) {
      Alert.alert('Timecard', 'Set break start before break end.');
      return;
    }
    if (breakStartIso) {
      const breakStartTs = new Date(breakStartIso).getTime();
      if (breakStartTs < new Date(inIso).getTime()) {
        Alert.alert('Timecard', 'Break start must be after clock in.');
        return;
      }
      if (breakStartTs > nowTs.getTime()) {
        Alert.alert('Timecard', 'Break start cannot be in the future.');
        return;
      }
    }
    if (breakEndIso) {
      const breakEndTs = new Date(breakEndIso).getTime();
      if (breakStartIso && breakEndTs < new Date(breakStartIso).getTime()) {
        Alert.alert('Timecard', 'Break end must be after break start.');
        return;
      }
      if (breakEndTs > nowTs.getTime()) {
        Alert.alert('Timecard', 'Break end cannot be in the future.');
        return;
      }
    }
    if (outIso) {
      const outD = new Date(outIso);
      if (outD.getTime() > nowTs.getTime()) {
        Alert.alert('Timecard', 'Clock out cannot be in the future.');
        return;
      }
      if (outD.getTime() < new Date(inIso).getTime()) {
        Alert.alert('Timecard', 'Clock out must be after clock in.');
        return;
      }
      const norm = normalizePunchTimesForShift(inIso, outIso, shiftRow.iso, shiftRow.shift.start);
      inIso = norm.clockInAt;
      outIso = norm.clockOutAt;
    }
    const br = breakMinutesFromRange(breakStartIso, breakEndIso, outIso);
    setBusy(true);
    const res = await saveManagerPunch(supabase, schema, {
      employeeId: emp.id,
      shiftId: shiftRow.shift.id,
      clockInIso: inIso,
      clockOutIso: outIso,
      breakStartIso,
      breakEndIso,
      breakMinutes: br,
      editingId: entryId || null,
      priorEntry: editingEntry,
    });
    setBusy(false);
    if (!res.ok) {
      Alert.alert('Save failed', res.message);
      return;
    }
    await refresh();
    Alert.alert('Saved', 'Punch updated.');
  };

  if (!emp || !shiftRow) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Shift not found.</Text>
      </View>
    );
  }

  const s = shiftRow.shift;
  const schedBreak = parseBreakMinutesFromAnnotation(s.redPokeBreak);
  const schedMins = scheduledPaidMinutes(s);
  const dayMins = dailyRecordedMinutesForEmployee(entries, emp.id, shiftRow.iso);
  const shiftPay = shiftPayForScheduledRecorded(emp, schedMins, dayMins);
  const payLabel = formatShiftPayLabel(shiftPay);
  const history = editingEntry ? formatHistoryLines(editingEntry) : [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Scheduled</Text>
        <Text style={styles.line}>
          {s.day} · {s.timeLabel || redPokeShiftTimeLabel(s.start, s.end)}
        </Text>
        <Text style={styles.line}>
          Paid {decimalHoursFromMinutes(scheduledPaidMinutes(s))}h · Break{' '}
          {schedBreak ? `${schedBreak} min` : 'none'}
        </Text>
        <Text style={styles.line}>
          Day total: {dayMins ? decimalHoursFromMinutes(roundToNearest5Minutes(dayMins)) + 'h' : '—'}
          {dayEntries.length > 1 ? ` · ${dayEntries.length} punches` : ''}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pay (this shift)</Text>
        <Text style={styles.line}>
          Regular {decimalHoursFromMinutes(shiftPay.regMins)}h · {formatPayAmount(shiftPay.regPay)}
        </Text>
        <Text style={styles.line}>
          Overtime {decimalHoursFromMinutes(shiftPay.otMins)}h · {formatPayAmount(shiftPay.otPay)}
        </Text>
        <Text style={styles.lineStrong}>Shift total {payLabel}</Text>
        <Text style={styles.line}>Pay/hr {formatHourlyRateLabel(emp)}</Text>
      </View>

      <Text style={styles.sectionTitle}>Punches this day</Text>
      {dayEntries.map((punch, idx) => {
        const active = punch.id === entryId;
        const paid = recordedPaidMinutes(punch, shiftRow);
        return (
          <Pressable
            key={punch.id}
            style={[styles.punchRow, active && styles.punchRowActive]}
            onPress={() => loadEntry(punch)}
          >
            <Text style={styles.punchTitle}>
              #{idx + 1} {formatPunchClock(punch.clock_in_at)} –{' '}
              {isEntryOpen(punch) ? 'still in' : formatPunchClock(punch.clock_out_at)}
              {formatBreakRangeLabel(punch)}
              {isEntryOpen(punch) ? ' (Open)' : ''}
            </Text>
            <Text style={styles.punchSub}>{decimalHoursFromMinutes(paid)}h paid</Text>
          </Pressable>
        );
      })}
      {!dayEntries.length ? <Text style={styles.muted}>No punches yet.</Text> : null}

      <Text style={styles.sectionTitle}>{editingEntry ? 'Edit punch' : 'Add punch'}</Text>
      <Text style={styles.hint}>Closed punches round to 5 minutes when saved.</Text>

      <DateTimePickerField
        label="Clock in"
        value={clockInDate}
        onChange={setClockInDate}
        maximumDate={new Date()}
      />

      <DateTimePickerField
        label="Clock out"
        value={clockOutDate}
        onChange={setClockOutDate}
        maximumDate={new Date()}
        minimumDate={clockInDate ?? undefined}
        allowClear
        clearLabel="Still clocked in"
      />

      <Pressable style={styles.btnSecondary} onPress={() => setClockOutDate(new Date())}>
        <Text style={styles.btnSecondaryText}>End punch now</Text>
      </Pressable>

      <DateTimePickerField
        label="Break start"
        value={breakStartDate}
        onChange={setBreakStartDate}
        maximumDate={new Date()}
        minimumDate={clockInDate ?? undefined}
      />

      <DateTimePickerField
        label="Break end"
        value={breakEndDate}
        onChange={setBreakEndDate}
        maximumDate={new Date()}
        minimumDate={breakStartDate ?? clockInDate ?? undefined}
        allowClear
        clearLabel="On break / no end"
      />

      <Pressable style={styles.btnSecondary} onPress={() => setBreakEndDate(new Date())}>
        <Text style={styles.btnSecondaryText}>End break now</Text>
      </Pressable>

      {previewPaid != null ? (
        <Text style={styles.preview}>
          Paid preview: {decimalHoursFromMinutes(previewPaid)}h
          {!clockOutDate ? ' · shift still open' : ''}
        </Text>
      ) : null}

      <Pressable style={styles.btnPrimary} disabled={busy} onPress={() => void save()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Save punch</Text>}
      </Pressable>
      <Pressable
        style={styles.btnSecondary}
        onPress={() => {
          setEntryId(null);
          loadEntry(null);
        }}
      >
        <Text style={styles.btnSecondaryText}>Add another punch</Text>
      </Pressable>

      {history.length ? (
        <>
          <Text style={styles.sectionTitle}>Edit history</Text>
          {history.map((h, i) => (
            <View key={i} style={styles.histBlock}>
              {h.when ? <Text style={styles.histWhen}>{h.when}</Text> : null}
              {h.lines.map((line, j) => (
                <Text key={j} style={styles.histLine}>
                  {line}
                </Text>
              ))}
            </View>
          ))}
        </>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 48 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    marginBottom: 16,
  },
  cardTitle: { fontSize: 14, fontWeight: '700', color: '#64748b', marginBottom: 8, textTransform: 'uppercase' },
  line: { fontSize: 14, color: '#334155', marginBottom: 4 },
  lineStrong: { fontSize: 15, fontWeight: '700', color: '#0f172a', marginTop: 4 },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginTop: 8, marginBottom: 8 },
  punchRow: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  punchRowActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  punchTitle: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
  punchSub: { fontSize: 13, color: '#64748b', marginTop: 4 },
  hint: { fontSize: 12, color: '#888', marginBottom: 4 },
  preview: { fontSize: 13, color: '#475569', marginTop: 10 },
  btnPrimary: {
    backgroundColor: '#c41230',
    padding: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 16,
  },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnSecondary: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 10,
    backgroundColor: '#fff',
  },
  btnSecondaryText: { color: '#334155', fontWeight: '700' },
  muted: { color: '#888', marginBottom: 12 },
  histBlock: { marginBottom: 12, paddingLeft: 4 },
  histWhen: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  histLine: { fontSize: 13, color: '#334155' },
});
