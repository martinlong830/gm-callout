import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useLocalSearchParams, useRouter, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import { employeeDisplayName, type EmployeeRow } from '../../../lib/employees';
import { GrandTotalsSection } from '../../../components/timecards/GrandTotalsSection';
import { PayWeekPicker } from '../../../components/PayWeekPicker';
import {
  buildRosterRow,
  buildScheduleContext,
  buildShiftsForEmployeeInWeek,
  computeRosterTotals,
  dailyRecordedMinutesForShiftRow,
  decimalHoursFromMinutes,
  findEntriesForDay,
  formatDayBreakLabel,
  formatRecordedHoursLabel,
  formatHourlyRateLabel,
  formatPayAmount,
  formatShiftPayLabel,
  scheduledPaidMinutes,
  shiftPayForShiftRow,
  type RosterTotals,
  type ShiftDayRow,
} from '../../../lib/timecards/engine';
import {
  availableOffScheduleDayOptions,
  addOffScheduleDay,
  entryHasMeaningfulPunch,
  getAddedOffScheduleDays,
  isOffScheduleShiftDayRow,
  offScheduleShiftIdForIso,
} from '../../../lib/timecards/offScheduleShift';
import { applyCrossRestaurantPunchSideEffects } from '../../../lib/timecards/crossRestaurantPunch';
import { removeShiftDay } from '../../../lib/timecards/shiftDayCleanup';
import {
  isDeliveryDishwasherStaff,
  getEmployeeDayDishwasherTipSync,
  loadDishwasherTipsSlice,
  netTipAmount,
} from '../../../lib/timecards/dishwasherTips';
import {
  getEmployeeDayAdditionalCashTipSync,
  getEffectiveDayLeaveSync,
  loadWeekExtrasSlice,
  type WeekExtrasSlice,
} from '../../../lib/timecards/weekExtras';
import {
  compactShiftTimeLabel,
  formatPayWeekDateLabel,
} from '../../../lib/schedule/employeeShiftDisplay';
import type { EmployeeLite } from '../../../lib/schedule/types';
import type { PayWeekBounds, TimeClockEntry } from '../../../lib/timecards/types';
import { supabase } from '../../../lib/supabase';

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

function formatClockTimeOnly(iso: string | null | undefined): string {
  if (!iso) return '—';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDayClockInOutLabel(entries: TimeClockEntry[], empId: string, iso: string): string {
  const parts: string[] = [];
  for (const e of findEntriesForDay(entries, empId, iso)) {
    if (!entryHasMeaningfulPunch(e, iso)) continue;
    const inLabel = formatClockTimeOnly(e.clock_in_at);
    const outLabel = e.clock_out_at ? formatClockTimeOnly(e.clock_out_at) : 'still in';
    parts.push(`${inLabel}–${outLabel}`);
  }
  return parts.length ? parts.join(' · ') : '—';
}

export default function TimecardsEmployeeScreen() {
  const { employeeId } = useLocalSearchParams<{ employeeId: string }>();
  const router = useRouter();
  const navigation = useNavigation();
  const { employees, staffRequests, teamState } = useAppData();
  const {
    entries,
    bounds,
    payWeekOptions,
    selectedWeekStartIso,
    setPayWeekStartIso,
    refresh,
  } = useTimecards();

  const emp = useMemo(
    () => employees.find((e) => e.id === employeeId) ?? null,
    [employees, employeeId]
  );

  const lites = useMemo(() => employees.map(toLite), [employees]);
  const scheduleCtx = useMemo(
    () => buildScheduleContext(teamState, { bounds, employees: lites }),
    [teamState, bounds, lites]
  );
  const [listVersion, setListVersion] = useState(0);
  const [extrasSlice, setExtrasSlice] = useState<WeekExtrasSlice>({});
  const [dishwasherTipsSlice, setDishwasherTipsSlice] = useState<Record<string, number>>({});
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  const loadShiftListData = useCallback(async () => {
    const [extras, tips] = await Promise.all([
      loadWeekExtrasSlice(bounds),
      loadDishwasherTipsSlice(bounds),
    ]);
    setExtrasSlice(extras);
    setDishwasherTipsSlice(tips);
    setListVersion((v) => v + 1);
  }, [bounds, teamState?.updated_at]);

  useFocusEffect(
    useCallback(() => {
      // Soft refresh: skip network when week punches were fetched recently (Realtime +
      // post-save force refresh still keep multi-manager sync correct).
      void Promise.all([
        refresh({ force: false, showLoading: false }),
        loadShiftListData(),
      ]);
    }, [refresh, loadShiftListData])
  );

  useEffect(() => {
    if (!entries.length || !employees.length) return;
    let changed = false;
    applyCrossRestaurantPunchSideEffects(entries, employees, () => {
      changed = true;
    });
    if (changed) setListVersion((v) => v + 1);
  }, [entries, employees]);

  const addedDayIsos = useMemo(
    () => (emp ? getAddedOffScheduleDays(emp.id) : []),
    [emp, listVersion]
  );
  const shifts = useMemo(
    () =>
      emp
        ? buildShiftsForEmployeeInWeek(emp, teamState, lites, bounds, undefined, {
            entries,
            extrasSlice,
            dishwasherTipsSlice,
            addedDayIsos,
            staffRequests,
          })
        : [],
    [emp, teamState, lites, bounds, entries, extrasSlice, dishwasherTipsSlice, addedDayIsos, staffRequests]
  );
  const existingIsos = useMemo(() => new Set(shifts.map((r) => r.iso)), [shifts]);
  const availableDays = useMemo(
    () => availableOffScheduleDayOptions(bounds, existingIsos),
    [bounds, existingIsos]
  );

  const [weekTotals, setWeekTotals] = useState<RosterTotals | null>(null);

  const loadWeekTotals = useCallback(async () => {
    if (!emp) return;
    const rosterRow = await buildRosterRow(emp, entries, teamState, staffRequests, lites, bounds);
    setWeekTotals(computeRosterTotals([rosterRow]));
  }, [emp, staffRequests, bounds, entries, teamState, lites, teamState?.updated_at]);

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

  const openOffScheduleDay = useCallback(
    (iso: string) => {
      if (!emp) return;
      setAddMenuOpen(false);
      if (existingIsos.has(iso)) {
        router.push({
          pathname: '/manager/timecards/[employeeId]/shift',
          params: { employeeId: emp.id, shiftId: offScheduleShiftIdForIso(iso), iso },
        });
        return;
      }
      addOffScheduleDay(emp.id, iso);
      setListVersion((v) => v + 1);
      router.push({
        pathname: '/manager/timecards/[employeeId]/shift',
        params: { employeeId: emp.id, shiftId: offScheduleShiftIdForIso(iso), iso },
      });
    },
    [emp, existingIsos, router]
  );

  if (!emp) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Employee not found.</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <View style={styles.weekPickerWrap}>
        <PayWeekPicker
          options={payWeekOptions}
          selectedStartIso={selectedWeekStartIso}
          onSelect={setPayWeekStartIso}
        />
      </View>
      {weekTotals ? (
        <GrandTotalsSection
          totals={weekTotals}
          bounds={bounds}
          showTipPool={false}
          metaLabel={`${employeeDisplayName(emp)} · week totals`}
          hourlyRateLabel={formatHourlyRateLabel(emp)}
        />
      ) : null}

      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>Shifts this pay week</Text>
        {availableDays.length ? (
          <View style={styles.addDayWrap}>
            <Pressable
              style={styles.addDayBtn}
              accessibilityLabel="Add off-schedule day"
              accessibilityRole="button"
              onPress={() => setAddMenuOpen((open) => !open)}
            >
              <Ionicons name="add" size={22} color="#0f172a" />
            </Pressable>
            {addMenuOpen ? (
              <View style={styles.addDayMenu}>
                {availableDays.map((day) => (
                  <Pressable
                    key={day.iso}
                    style={styles.addDayMenuItem}
                    onPress={() => openOffScheduleDay(day.iso)}
                  >
                    <Text style={styles.addDayMenuText}>{day.label}</Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </View>
      {!shifts.length ? (
        <Text style={styles.muted}>No shifts this pay week yet. Use + to add an off-schedule day.</Text>
      ) : (
        shifts.map((row) => (
          <ShiftRowCard
            key={`${row.shift.restaurantId}-${row.shift.id}`}
            row={row}
            empId={emp.id}
            emp={emp}
            entries={entries}
            bounds={bounds}
            scheduleCtx={scheduleCtx}
            extrasSlice={extrasSlice}
            dishwasherTipsSlice={dishwasherTipsSlice}
            staffRequests={staffRequests}
            onRemoved={async () => {
              await refresh();
              await loadShiftListData();
              await loadWeekTotals();
            }}
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

function formatDayLeaveHoursLabel(hours: number): string {
  if (!hours || hours <= 0) return '—';
  return decimalHoursFromMinutes(hours * 60) + 'h';
}

function ShiftRowCard({
  row,
  empId,
  emp,
  entries,
  bounds,
  scheduleCtx,
  extrasSlice,
  dishwasherTipsSlice,
  staffRequests,
  onRemoved,
  onPress,
}: {
  row: ShiftDayRow;
  empId: string;
  emp: EmployeeRow;
  entries: TimeClockEntry[];
  bounds: PayWeekBounds;
  scheduleCtx: ReturnType<typeof buildScheduleContext>;
  extrasSlice: WeekExtrasSlice;
  dishwasherTipsSlice: Record<string, number>;
  staffRequests: import('../../../lib/staffRequests').StaffRequestUi[];
  onRemoved: () => Promise<void>;
  onPress: () => void;
}) {
  const s = row.shift;
  const dayEntries = findEntriesForDay(entries, empId, row.iso);
  const recMins = dailyRecordedMinutesForShiftRow(emp, row, entries, scheduleCtx);
  const breakLabel = formatDayBreakLabel(entries, empId, row.iso);
  const offSchedule = isOffScheduleShiftDayRow(row);
  const shiftPay = shiftPayForShiftRow(emp, row, entries, scheduleCtx);
  const payLabel = formatShiftPayLabel(shiftPay);
  const rateLabel = formatHourlyRateLabel(emp);
  const dateLabel = formatPayWeekDateLabel(row.iso);
  const shiftTime = offSchedule ? 'Off schedule' : compactShiftTimeLabel(s);
  const when =
    (row.isToday ? 'Today · ' : row.isUpcoming ? 'Upcoming · ' : '') + shiftTime;
  const inOutLabel = formatDayClockInOutLabel(entries, empId, row.iso);
  const dayLeave = getEffectiveDayLeaveSync(
    emp,
    employeeDisplayName(emp),
    row.iso,
    bounds,
    staffRequests,
    {},
    extrasSlice
  );
  const showDishwasherTips = isDeliveryDishwasherStaff(emp);
  const dayDishwasherTip = showDishwasherTips
    ? getEmployeeDayDishwasherTipSync(empId, row.iso, dishwasherTipsSlice)
    : 0;
  const dayCoverage = getEmployeeDayAdditionalCashTipSync(empId, row.iso, extrasSlice);

  const confirmRemove = () => {
    const message = offSchedule
      ? 'Remove this off-schedule day and clear all punches, leave, and tips?'
      : 'Clear all punches, leave, and tips for this shift day? The scheduled shift will stay with 0h recorded.';
    Alert.alert('Remove shift day', message, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            if (!supabase) {
              Alert.alert('Remove failed', 'Cloud sign-in is required.');
              return;
            }
            const res = await removeShiftDay(supabase, emp, row, entries, bounds, {
              clearDishwasherTip: isDeliveryDishwasherStaff(emp),
            });
            if (!res.ok) {
              Alert.alert('Remove failed', res.message);
              return;
            }
            await onRemoved();
          })();
        },
      },
    ]);
  };

  return (
    <Pressable style={styles.shiftCard} onPress={onPress}>
      <View style={styles.cardTop}>
        <View style={styles.cardHeadings}>
          <Text style={styles.shiftDate}>{dateLabel}</Text>
          <Text style={styles.shiftWhen}>{when}</Text>
        </View>
        <Pressable
          style={styles.removeDayBtn}
          accessibilityLabel="Remove shift day"
          accessibilityRole="button"
          hitSlop={8}
          onPress={(e) => {
            e.stopPropagation();
            confirmRemove();
          }}
        >
          <Ionicons name="trash-outline" size={18} color="#94a3b8" />
        </Pressable>
      </View>
      <Text style={styles.shiftMeta}>In / Out {inOutLabel}</Text>
      <Text style={styles.shiftMeta}>
        Sched {offSchedule ? '—' : decimalHoursFromMinutes(scheduledPaidMinutes(s, emp)) + 'h'} · Rec{' '}
        {formatRecordedHoursLabel(recMins)}
        {dayEntries.length > 1 ? ` · ${dayEntries.length} punches` : ''}
      </Text>
      <Text style={styles.shiftMeta}>Break {breakLabel}</Text>
      <Text style={styles.shiftMeta}>
        VL {formatDayLeaveHoursLabel(dayLeave.vl)} · SL {formatDayLeaveHoursLabel(dayLeave.sl)}
      </Text>
      {showDishwasherTips ? (
        <Text style={styles.shiftMeta}>
          Net delivery tip{' '}
          {dayDishwasherTip > 0 ? formatPayAmount(netTipAmount(dayDishwasherTip)) : '—'}
        </Text>
      ) : null}
      {dayCoverage > 0 ? (
        <Text style={styles.shiftMeta}>Coverage {formatPayAmount(dayCoverage)}</Text>
      ) : null}
      <Text style={styles.shiftPay}>
        Pay {payLabel} · Pay/hr {rateLabel}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 40 },
  weekPickerWrap: { marginHorizontal: -16, marginBottom: 4 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10,
    marginTop: 4,
    zIndex: 2,
  },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', flex: 1 },
  shiftCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    marginBottom: 8,
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' },
  cardHeadings: { flex: 1, gap: 2 },
  removeDayBtn: {
    padding: 4,
    borderRadius: 6,
  },
  shiftDate: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  shiftWhen: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  shiftMeta: { fontSize: 13, color: '#64748b', marginTop: 6 },
  shiftPay: { fontSize: 13, fontWeight: '600', color: '#0f172a', marginTop: 4 },
  muted: { color: '#888', textAlign: 'center', marginTop: 20 },
  addDayWrap: { position: 'relative' },
  addDayBtn: {
    width: 32,
    height: 32,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  addDayMenu: {
    position: 'absolute',
    top: 36,
    right: 0,
    minWidth: 140,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    shadowColor: '#0f172a',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 16,
    elevation: 6,
    overflow: 'hidden',
  },
  addDayMenuItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  addDayMenuText: { fontSize: 14, color: '#0f172a' },
});
