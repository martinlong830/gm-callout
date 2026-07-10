import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { DateTimePickerField } from '../../../../components/DateTimePickerField';
import { useAppData } from '../../../../contexts/AppDataContext';
import { useTimecards } from '../../../../contexts/TimecardsContext';
import { employeeDisplayName, type EmployeeRow } from '../../../../lib/employees';
import {
  DISHWASHER_TIP_REQUIRES_SHIFT_MSG,
  getEmployeeDayDishwasherTip,
  isDeliveryDishwasherStaff,
  setEmployeeDayDishwasherTip,
} from '../../../../lib/timecards/dishwasherTips';
import { deleteTimeClockEntries, saveManagerPunch } from '../../../../lib/timecards/entriesApi';
import {
  employeeBreakPolicy,
  formatBreakPolicyLabel,
  resolveBreakPaid,
} from '../../../../lib/timecards/breakPolicy';
import { removeShiftDay } from '../../../../lib/timecards/shiftDayCleanup';
import {
  buildShiftsForEmployeeInWeek,
  buildScheduledMinutesByDayForEmployee,
  buildScheduleContext,
  getEmployeeDayLeave,
  getSuggestedDayLeave,
  setEmployeeDayLeave,
  dailyRecordedMinutesForEmployeeAtRestaurant,
  decimalHoursFromMinutes,
  entriesForShiftDayCleanup,
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
  shiftPayForShiftRow,
  shiftRowAttributionRestaurant,
  type ShiftDayRow,
} from '../../../../lib/timecards/engine';
import {
  dateToIso,
  isMidnightOnShiftDate,
  parseIsoToDate,
  shiftDateAtMidnight,
} from '../../../../lib/timecards/punch';
import { redPokeShiftTimeLabel } from '../../../../lib/schedule/engine';
import type { EmployeeLite } from '../../../../lib/schedule/types';
import type { TimeClockEntry } from '../../../../lib/timecards/types';
import {
  isOffScheduleShiftDayRow,
  isoFromOffScheduleShiftId,
  makeOffScheduleShiftDayRow,
  scheduleShiftIdForSave,
} from '../../../../lib/timecards/offScheduleShift';
import { supabase } from '../../../../lib/supabase';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
    meta: e.meta,
  };
}

export default function TimecardsShiftScreen() {
  const { employeeId, shiftId, iso } = useLocalSearchParams<{
    employeeId: string;
    shiftId: string;
    iso: string;
  }>();
  const navigation = useNavigation();
  const router = useRouter();
  const { employees, teamState, staffRequests } = useAppData();
  const { entries, schema, refresh, bounds } = useTimecards();
  const [breakPaidChoice, setBreakPaidChoice] = useState<'inherit' | 'paid' | 'unpaid'>('inherit');

  const emp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );
  const lites = useMemo(() => employees.map(toLite), [employees]);

  const scheduleCtx = useMemo(() => buildScheduleContext(teamState), [teamState]);

  const weekShifts = useMemo(() => {
    if (!emp) return [];
    return buildShiftsForEmployeeInWeek(emp, teamState, lites, bounds, scheduleCtx, { entries });
  }, [emp, teamState, lites, bounds, entries, scheduleCtx]);

  const shiftRow = useMemo((): ShiftDayRow | null => {
    if (!emp || !iso) return null;
    const found = weekShifts.find((r) => r.shift.id === shiftId && r.iso === iso);
    if (found) return found;
    if (isoFromOffScheduleShiftId(shiftId) === iso) {
      return makeOffScheduleShiftDayRow(iso);
    }
    return null;
  }, [emp, weekShifts, shiftId, iso]);

  const dayEntries = useMemo(
    () => (emp && iso ? findEntriesForDay(entries, emp.id, iso) : []),
    [emp, entries, iso]
  );

  const [entryId, setEntryId] = useState<string | null>(null);
  const [clockInDate, setClockInDate] = useState<Date | null>(null);
  const [clockOutDate, setClockOutDate] = useState<Date | null>(null);
  const [breakStartDate, setBreakStartDate] = useState<Date | null>(null);
  const [breakEndDate, setBreakEndDate] = useState<Date | null>(null);
  const [vlText, setVlText] = useState('0');
  const [slText, setSlText] = useState('0');
  const [suggestedLeave, setSuggestedLeave] = useState<{ vl: number; sl: number } | null>(null);
  const [dishwasherTipText, setDishwasherTipText] = useState('0');
  const [busy, setBusy] = useState(false);
  const [punchesCleared, setPunchesCleared] = useState(false);
  const showDishwasherTip = emp ? isDeliveryDishwasherStaff(emp) : false;

  const loadDayLeave = useCallback(async () => {
    if (!emp || !iso) return;
    setVlText('0');
    setSlText('0');
    setSuggestedLeave(null);
    const dayLeave = await getEmployeeDayLeave(emp.id, iso, bounds);
    setVlText(String(dayLeave.vl));
    setSlText(String(dayLeave.sl));
    const schedMinsByDay = buildScheduledMinutesByDayForEmployee(emp, teamState, lites, bounds);
    const suggested = await getSuggestedDayLeave(
      emp,
      employeeDisplayName(emp),
      iso,
      bounds,
      staffRequests,
      schedMinsByDay
    );
    if (suggested.vl > 0 || suggested.sl > 0) {
      setSuggestedLeave(suggested);
    }
    if (isDeliveryDishwasherStaff(emp)) {
      const tip = await getEmployeeDayDishwasherTip(emp.id, iso, bounds);
      setDishwasherTipText(String(tip));
    }
  }, [emp, iso, bounds, teamState, lites, staffRequests]);

  const loadEntry = useCallback(
    (entry: TimeClockEntry | null) => {
      setPunchesCleared(false);
      const fieldDate = (iso: string | null | undefined) => {
        if (iso) return parseIsoToDate(iso);
        if (shiftRow?.iso) return shiftDateAtMidnight(shiftRow.iso);
        return null;
      };
      setEntryId(entry?.id ?? null);
      setClockInDate(fieldDate(entry?.clock_in_at));
      setClockOutDate(fieldDate(entry?.clock_out_at));
      setBreakStartDate(fieldDate(entry?.break_start_at));
      setBreakEndDate(fieldDate(entry?.break_end_at));
      if (entry?.break_paid != null) {
        setBreakPaidChoice(entry.break_paid ? 'paid' : 'unpaid');
      } else {
        setBreakPaidChoice('inherit');
      }
    },
    [shiftRow?.iso]
  );

  useEffect(() => {
    if (!shiftRow || !emp) return;
    const s = shiftRow.shift;
    const offSchedule = isOffScheduleShiftDayRow(shiftRow);
    navigation.setOptions({
      title: offSchedule
        ? s.day + ' · Off schedule'
        : s.day + ' · ' + (s.timeLabel || redPokeShiftTimeLabel(s.start, s.end)),
    });
    const open = dayEntries.filter(isEntryOpen);
    const pick = open.length ? open[open.length - 1] : dayEntries[dayEntries.length - 1] ?? null;
    loadEntry(pick);
    void loadDayLeave();
  }, [shiftRow, emp, dayEntries, navigation, loadEntry, loadDayLeave]);

  const hasPunchTimes = useMemo(() => {
    if (!shiftRow) return false;
    const shiftIso = shiftRow.iso;
    const hasIn = clockInDate && !isMidnightOnShiftDate(clockInDate, shiftIso);
    const hasOut = clockOutDate && !isMidnightOnShiftDate(clockOutDate, shiftIso);
    const hasBreakStart = breakStartDate && !isMidnightOnShiftDate(breakStartDate, shiftIso);
    const hasBreakEnd = breakEndDate && !isMidnightOnShiftDate(breakEndDate, shiftIso);
    return !!(hasIn || hasOut || hasBreakStart || hasBreakEnd);
  }, [clockInDate, clockOutDate, breakStartDate, breakEndDate, shiftRow]);

  const editingEntry = useMemo(
    () => (entryId ? dayEntries.find((e) => e.id === entryId) ?? null : null),
    [entryId, dayEntries]
  );

  const previewPaid = useMemo(() => {
    if (!shiftRow) return null;
    const inIso = dateToIso(clockInDate);
    if (!inIso || isMidnightOnShiftDate(clockInDate, shiftRow.iso)) return null;
    const breakStartIso =
      breakStartDate && !isMidnightOnShiftDate(breakStartDate, shiftRow.iso)
        ? dateToIso(breakStartDate)
        : null;
    const breakEndIso =
      breakEndDate && !isMidnightOnShiftDate(breakEndDate, shiftRow.iso)
        ? dateToIso(breakEndDate)
        : null;
    const outIso =
      clockOutDate && !isMidnightOnShiftDate(clockOutDate, shiftRow.iso)
        ? dateToIso(clockOutDate)
        : null;
    const fake: TimeClockEntry = {
      id: '',
      employee_id: emp?.id ?? '',
      clock_in_at: inIso,
      clock_out_at: outIso,
      break_start_at: breakStartIso,
      break_end_at: breakEndIso,
      break_minutes: 0,
    };
    return recordedPaidMinutes(fake, shiftRow);
  }, [clockInDate, clockOutDate, breakStartDate, breakEndDate, emp, shiftRow]);

  const clearPunchFields = useCallback(() => {
    setClockInDate(null);
    setClockOutDate(null);
    setBreakStartDate(null);
    setBreakEndDate(null);
    setEntryId(null);
    setPunchesCleared(true);
    setVlText('0');
    setSlText('0');
    setDishwasherTipText('0');
  }, []);

  const finishClearedDaySave = async (_vl: number, _sl: number, _dishwasherTip: number) => {
    if (!emp || !shiftRow || !supabase) return;
    setBusy(true);
    const res = await removeShiftDay(supabase, emp, shiftRow, entries, bounds, {
      clearDishwasherTip: showDishwasherTip,
      extraEntryIds: entryId ? [entryId] : [],
    });
    if (!res.ok) {
      setBusy(false);
      Alert.alert('Save failed', res.message);
      return;
    }
    setBusy(false);
    await refresh();
    router.back();
  };

  const save = async () => {
    if (!emp || !shiftRow || !supabase) return;
    const vl = Math.max(0, parseFloat(vlText) || 0);
    const sl = Math.max(0, parseFloat(slText) || 0);
    const dishwasherTip = showDishwasherTip ? Math.max(0, parseFloat(dishwasherTipText) || 0) : 0;
    let inIso = dateToIso(clockInDate);
    let outIso =
      clockOutDate && !isMidnightOnShiftDate(clockOutDate, shiftRow.iso)
        ? dateToIso(clockOutDate)
        : null;
    const breakStartIso =
      breakStartDate && !isMidnightOnShiftDate(breakStartDate, shiftRow.iso)
        ? dateToIso(breakStartDate)
        : null;
    const breakEndIso =
      breakEndDate && !isMidnightOnShiftDate(breakEndDate, shiftRow.iso)
        ? dateToIso(breakEndDate)
        : null;

    if (punchesCleared) {
      await finishClearedDaySave(0, 0, 0);
      return;
    }

    if (!hasPunchTimes) {
      const removingDay =
        punchesCleared || (vl <= 0 && sl <= 0 && dishwasherTip <= 0);
      if (removingDay) {
        await finishClearedDaySave(0, 0, 0);
        return;
      }
      if (showDishwasherTip && dishwasherTip > 0 && vl <= 0 && sl <= 0) {
        Alert.alert('Timecard', DISHWASHER_TIP_REQUIRES_SHIFT_MSG);
        return;
      }
      setBusy(true);
      const dayEntryIds = entriesForShiftDayCleanup(entries, emp.id, shiftRow, entryId ? [entryId] : []).map(
        (e) => e.id
      );
      if (dayEntryIds.length) {
        const delRes = await deleteTimeClockEntries(supabase, dayEntryIds);
        if (!delRes.ok) {
          setBusy(false);
          Alert.alert('Save failed', delRes.message);
          return;
        }
        if (delRes.deletedIds.length !== dayEntryIds.length) {
          setBusy(false);
          Alert.alert(
            'Save failed',
            'Could not delete all punch records. Sign in as a manager and apply the latest Supabase migrations (time_clock_entries_delete_managers).'
          );
          return;
        }
      }
      await setEmployeeDayLeave(emp.id, shiftRow.iso, vl, sl, bounds);
      if (showDishwasherTip) {
        await setEmployeeDayDishwasherTip(emp.id, shiftRow.iso, dishwasherTip, bounds);
      }
      setBusy(false);
      await refresh();
      Alert.alert('Saved', 'Vacation/sick hours saved for this day.');
      return;
    }

    if (!inIso || isMidnightOnShiftDate(clockInDate, shiftRow.iso)) {
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
    const breakPaid =
      breakPaidChoice === 'paid' ? true : breakPaidChoice === 'unpaid' ? false : null;
    const res = await saveManagerPunch(supabase, schema, {
      employeeId: emp.id,
      shiftId: scheduleShiftIdForSave(shiftRow.shift.id),
      clockInIso: inIso,
      clockOutIso: outIso,
      breakStartIso,
      breakEndIso,
      breakMinutes: br,
      breakPaid,
      editingId: entryId || null,
      priorEntry: editingEntry,
    });
    setBusy(false);
    if (!res.ok) {
      Alert.alert('Save failed', res.message);
      return;
    }
    await setEmployeeDayLeave(emp.id, shiftRow.iso, vl, sl, bounds);
    if (showDishwasherTip) {
      await setEmployeeDayDishwasherTip(emp.id, shiftRow.iso, dishwasherTip, bounds);
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
  const offSchedule = isOffScheduleShiftDayRow(shiftRow);
  const schedBreak = parseBreakMinutesFromAnnotation(s.redPokeBreak);
  const rowRest = emp && shiftRow ? shiftRowAttributionRestaurant(emp, shiftRow, entries, scheduleCtx) : 'rp-9';
  const dayMins = emp && shiftRow
    ? dailyRecordedMinutesForEmployeeAtRestaurant(emp, shiftRow.iso, rowRest, entries, scheduleCtx)
    : 0;
  const shiftPay =
    emp && shiftRow ? shiftPayForShiftRow(emp, shiftRow, entries, scheduleCtx) : null;
  const history = editingEntry ? formatHistoryLines(editingEntry) : [];

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{offSchedule ? 'Day (off schedule)' : 'Scheduled'}</Text>
        <Text style={styles.line}>
          {s.day}
          {offSchedule ? ' · Off schedule' : ` · ${s.timeLabel || redPokeShiftTimeLabel(s.start, s.end)}`}
        </Text>
        {!offSchedule ? (
          <Text style={styles.line}>
            Paid {decimalHoursFromMinutes(scheduledPaidMinutes(s))}h · Break{' '}
            {schedBreak ? `${schedBreak} min` : 'none'}
          </Text>
        ) : (
          <Text style={styles.line}>No scheduled shift — recorded time uses weekly 40h regular cap.</Text>
        )}
        <Text style={styles.line}>
          Day total: {dayMins ? decimalHoursFromMinutes(roundToNearest5Minutes(dayMins)) + 'h' : '—'}
          {dayEntries.length > 1 ? ` · ${dayEntries.length} punches` : ''}
        </Text>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardTitle}>Pay (this shift)</Text>
        <Text style={styles.line}>
          Regular {decimalHoursFromMinutes(shiftPay?.regMins ?? 0)}h ·{' '}
          {formatPayAmount(shiftPay?.regPay)}
        </Text>
        <Text style={styles.line}>
          Overtime {decimalHoursFromMinutes(shiftPay?.otMins ?? 0)}h · {formatPayAmount(shiftPay?.otPay)}
        </Text>
        <Text style={styles.lineStrong}>Shift total {shiftPay ? formatShiftPayLabel(shiftPay) : '—'}</Text>
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
        allowClear
        clearLabel="No clock in"
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

      <Pressable style={styles.btnSecondary} onPress={clearPunchFields}>
        <Text style={styles.btnSecondaryText}>Clear punch times</Text>
      </Pressable>

      <Pressable style={styles.btnSecondary} onPress={() => setClockOutDate(new Date())}>
        <Text style={styles.btnSecondaryText}>End punch now</Text>
      </Pressable>

      <DateTimePickerField
        label="Break start"
        value={breakStartDate}
        onChange={setBreakStartDate}
        maximumDate={new Date()}
        minimumDate={clockInDate ?? undefined}
        allowClear
        clearLabel="No break"
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

      <Text style={styles.sectionTitle}>Break on this punch</Text>
      <Text style={styles.hint}>
        Default for {employeeDisplayName(emp)}: {formatBreakPolicyLabel(employeeBreakPolicy(emp) === 'paid')}
      </Text>
      <View style={styles.chipRow}>
        {(['inherit', 'paid', 'unpaid'] as const).map((c) => {
          const on = breakPaidChoice === c;
          const label = c === 'inherit' ? 'Default' : c === 'paid' ? 'Paid' : 'Unpaid';
          return (
            <Pressable
              key={c}
              style={[styles.chip, on && styles.chipOn]}
              onPress={() => setBreakPaidChoice(c)}
            >
              <Text style={[styles.chipText, on && styles.chipTextOn]}>{label}</Text>
            </Pressable>
          );
        })}
      </View>
      {editingEntry ? (
        <Text style={styles.hint}>
          Effective: {formatBreakPolicyLabel(resolveBreakPaid({ entry: editingEntry, shift: s, emp }))}
        </Text>
      ) : null}

      <Text style={styles.sectionTitle}>VL / SL (this day)</Text>
      <Text style={styles.hint}>
        Saved per-day only — week totals may include other days or approved time off. Clear both
        fields to 0 to remove leave from this day.
      </Text>
      {suggestedLeave && (suggestedLeave.vl > 0 || suggestedLeave.sl > 0) ? (
        <Text style={styles.hint}>
          Approved time off suggests{' '}
          {suggestedLeave.vl > 0 ? `VL ${suggestedLeave.vl}h` : ''}
          {suggestedLeave.vl > 0 && suggestedLeave.sl > 0 ? ' · ' : ''}
          {suggestedLeave.sl > 0 ? `SL ${suggestedLeave.sl}h` : ''} for this day (not saved until
          you enter it below).
        </Text>
      ) : null}
      <Text style={styles.fieldLabel}>VL (hrs)</Text>
      <TextInput
        style={styles.input}
        value={vlText}
        onChangeText={setVlText}
        keyboardType="decimal-pad"
      />
      <Text style={styles.fieldLabel}>SL (hrs)</Text>
      <TextInput
        style={styles.input}
        value={slText}
        onChangeText={setSlText}
        keyboardType="decimal-pad"
      />

      {showDishwasherTip ? (
        <>
          <Text style={styles.sectionTitle}>Dishwasher tip (this day)</Text>
          <Text style={styles.hint}>Cash tips for delivery/dishwasher shifts (saved per day).</Text>
          <Text style={styles.fieldLabel}>Tip ($)</Text>
          <TextInput
            style={styles.input}
            value={dishwasherTipText}
            onChangeText={setDishwasherTipText}
            keyboardType="decimal-pad"
          />
        </>
      ) : null}

      {previewPaid != null ? (
        <Text style={styles.preview}>
          Paid preview: {decimalHoursFromMinutes(previewPaid)}h
          {!clockOutDate || (shiftRow && isMidnightOnShiftDate(clockOutDate, shiftRow.iso))
            ? ' · shift still open'
            : ''}
        </Text>
      ) : hasPunchTimes ? null : (
        <Text style={styles.preview}>No punch times — save VL/SL below for vacation or sick days.</Text>
      )}

      <Pressable style={styles.btnPrimary} disabled={busy} onPress={() => void save()}>
        {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnPrimaryText}>Save</Text>}
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
  fieldLabel: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 4, marginTop: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    backgroundColor: '#fff',
    fontSize: 16,
  },
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
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  chipOn: { backgroundColor: '#c41230', borderColor: '#c41230' },
  chipText: { fontSize: 14, color: '#334155', fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  muted: { color: '#888', marginBottom: 12 },
  histBlock: { marginBottom: 12, paddingLeft: 4 },
  histWhen: { fontSize: 12, color: '#64748b', marginBottom: 4 },
  histLine: { fontSize: 13, color: '#334155' },
});
