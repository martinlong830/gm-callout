import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { PayWeekPicker } from '../../../components/PayWeekPicker';
import { GrandTotalsSection } from '../../../components/timecards/GrandTotalsSection';
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import {
  buildAllRosterRows,
  computeRosterTotals,
  decimalHoursFromMinutes,
  formatPayAmount,
  type RosterRow,
} from '../../../lib/timecards/engine';
import { loadDishwasherTipsSlice } from '../../../lib/timecards/dishwasherTips';
import { loadWeekExtrasSlice } from '../../../lib/timecards/weekExtras';
import {
  loadTimecardsLocationFilter,
  saveTimecardsLocationFilter,
  TIMECARDS_LOCATION_OPTIONS,
  type SelectedRestaurant,
} from '../../../lib/timecards/locationFilter';
import { rosterRowVisibleAtLocation } from '../../../lib/timecards/restaurantAttribution';
import type { EmployeeLite } from '../../../lib/schedule/types';
import { compareEmployeesByScheduleOrder } from '../../../lib/schedule/rosterOrder';
import { weekBoundsStorageKey } from '../../../lib/timecards/payWeek';
import { type EmployeeRow } from '../../../lib/employees';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function HoursPayStat({
  label,
  mins,
  pay,
}: {
  label: string;
  mins: number;
  pay: number | null;
}) {
  return (
    <View style={styles.statRow}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statHours}>{decimalHoursFromMinutes(mins)}h</Text>
      <Text style={styles.statPay}>{pay != null ? formatPayAmount(pay) : '—'}</Text>
    </View>
  );
}

function clockBadgeStyle(status: RosterRow['clockStatus']) {
  if (status === 'clocked_in') return styles.clockIn;
  if (status === 'on_break') return styles.clockBreak;
  return styles.clockOff;
}

function RosterRowCard({
  row,
  onPress,
}: {
  row: RosterRow;
  onPress: () => void;
}) {
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.name}>{row.name}</Text>
        <Text style={[styles.clockBadge, clockBadgeStyle(row.clockStatus)]}>
          {row.clockStatusLabel}
        </Text>
      </View>
      <Text style={styles.role}>{row.role}</Text>
      <View style={styles.statsGrid}>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>Scheduled</Text>
          <Text style={styles.statHours}>{decimalHoursFromMinutes(row.schedMins)}h</Text>
        </View>
        <HoursPayStat label="Regular" mins={row.regMins} pay={row.regPay} />
        <HoursPayStat label="OT" mins={row.otMins} pay={row.otPay} />
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>VL / SL</Text>
          <Text style={styles.statHours}>
            {row.vlHours.toFixed(1)}h / {row.slHours.toFixed(1)}h
          </Text>
        </View>
        <View style={styles.statRow}>
          <Text style={styles.statLabel}>SoH</Text>
          <Text style={styles.statHours}>
            {row.sohCount} · {row.sohDatesLabel}
          </Text>
          {row.sohPay != null ? (
            <Text style={styles.statPay}>{formatPayAmount(row.sohPay)}</Text>
          ) : null}
        </View>
        {row.dishwasherTipsPay > 0 ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Dishwasher tips</Text>
            <Text style={styles.statPay}>{formatPayAmount(row.dishwasherTipsPay)}</Text>
          </View>
        ) : null}
        <View style={[styles.statRow, styles.totalRow]}>
          <Text style={styles.totalLabel}>Total</Text>
          <Text style={styles.totalHours}>
            {decimalHoursFromMinutes(row.regMins + row.otMins)}h
          </Text>
          <Text style={styles.totalPay}>{formatPayAmount(row.grandTotalPay)}</Text>
        </View>
      </View>
    </Pressable>
  );
}

type WeekSlices = {
  key: string;
  extras: Record<string, { vl: number; sl: number; manual?: boolean }>;
  dishwasherTips: Record<string, number>;
};

export default function TimecardsRosterScreen() {
  const router = useRouter();
  const { employees, staffRequests, teamState } = useAppData();
  const {
    entries,
    loading,
    error,
    bounds,
    payWeekOptions,
    selectedWeekStartIso,
    setPayWeekStartIso,
    refresh,
  } = useTimecards();
  const [weekSlices, setWeekSlices] = useState<WeekSlices | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [locationFilter, setLocationFilter] = useState<SelectedRestaurant>('rp-9');
  const [locationReady, setLocationReady] = useState(false);

  const boundsKey = weekBoundsStorageKey(bounds);
  const lites = useMemo(() => employees.map(toLite), [employees]);
  const employeeById = useMemo(
    () => Object.fromEntries(employees.map((e) => [e.id, e])),
    [employees]
  );

  useEffect(() => {
    void loadTimecardsLocationFilter().then((loc) => {
      setLocationFilter(loc);
      setLocationReady(true);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([loadWeekExtrasSlice(bounds), loadDishwasherTipsSlice(bounds)]).then(
      ([extras, dishwasherTips]) => {
        if (cancelled) return;
        setWeekSlices({ key: boundsKey, extras, dishwasherTips });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bounds, boundsKey]);

  const rows = useMemo(() => {
    if (loading || !locationReady || !weekSlices || weekSlices.key !== boundsKey) return [];
    const built = buildAllRosterRows(
      employees,
      entries,
      teamState,
      staffRequests,
      lites,
      weekSlices.extras,
      weekSlices.dishwasherTips,
      bounds,
      locationFilter
    );
    built.sort((a, b) => {
      const empA = employeeById[a.empId];
      const empB = employeeById[b.empId];
      if (empA && empB) return compareEmployeesByScheduleOrder(empA, empB);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    return built.filter((row) => {
      const emp = employeeById[row.empId];
      return emp ? rosterRowVisibleAtLocation(emp, locationFilter) : true;
    });
  }, [
    loading,
    locationReady,
    weekSlices,
    boundsKey,
    employees,
    entries,
    teamState,
    staffRequests,
    lites,
    bounds,
    locationFilter,
    employeeById,
    teamState?.updated_at,
  ]);

  const onLocationChange = useCallback(async (next: SelectedRestaurant) => {
    setLocationFilter(next);
    await saveTimecardsLocationFilter(next);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  }, [refresh]);

  const totals = useMemo(() => computeRosterTotals(rows), [rows]);
  const initialBusy = (loading || !weekSlices || weekSlices.key !== boundsKey) && !rows.length;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#c41230" />
      }
    >
      <PayWeekPicker
        options={payWeekOptions}
        selectedStartIso={selectedWeekStartIso}
        onSelect={setPayWeekStartIso}
      />

      <View style={styles.locationSection}>
        <Text style={styles.locationLabel}>Location</Text>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          nestedScrollEnabled
          contentContainerStyle={styles.locationPicker}
        >
          {TIMECARDS_LOCATION_OPTIONS.map((opt) => {
            const on = opt.id === locationFilter;
            return (
              <Pressable
                key={opt.id}
                style={[styles.locationChip, on && styles.locationChipOn]}
                onPress={() => void onLocationChange(opt.id)}
              >
                <Text style={[styles.locationChipText, on && styles.locationChipTextOn]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {error ? <Text style={styles.err}>{error}</Text> : null}

      {initialBusy ? <ActivityIndicator style={styles.spinner} color="#c41230" /> : null}

      {rows.length > 0 ? <GrandTotalsSection totals={totals} bounds={bounds} /> : null}

      <View style={styles.list}>
        {rows.map((row) => {
          if (!employeeById[row.empId]) return null;
          return (
            <RosterRowCard
              key={row.empId}
              row={row}
              onPress={() =>
                router.push({
                  pathname: '/manager/timecards/[employeeId]',
                  params: { employeeId: row.empId },
                })
              }
            />
          );
        })}
        {!initialBusy && !employees.length ? (
          <Text style={styles.muted}>No employees on the roster.</Text>
        ) : null}
        {!initialBusy && employees.length > 0 && !rows.length ? (
          <Text style={styles.muted}>No employees at this location for this pay week.</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  scrollContent: { paddingBottom: 32 },
  locationSection: { paddingHorizontal: 16, paddingBottom: 8, paddingTop: 4 },
  locationLabel: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6 },
  locationPicker: { gap: 8 },
  locationChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  locationChipOn: { borderColor: '#c41230', backgroundColor: '#fef2f2' },
  locationChipText: { fontSize: 12, color: '#475569' },
  locationChipTextOn: { color: '#c41230', fontWeight: '700' },
  err: { color: '#b91c1c', paddingHorizontal: 16, paddingBottom: 8 },
  spinner: { marginTop: 40 },
  list: { paddingHorizontal: 16, paddingTop: 4, gap: 10 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  cardTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 },
  name: { fontSize: 17, fontWeight: '700', color: '#0f172a', flex: 1 },
  clockBadge: {
    fontSize: 11,
    fontWeight: '600',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    overflow: 'hidden',
  },
  clockIn: { backgroundColor: '#ecfdf5', color: '#047857' },
  clockBreak: { backgroundColor: '#fffbeb', color: '#b45309' },
  clockOff: { backgroundColor: '#f3f4f6', color: '#6b7280' },
  role: { fontSize: 13, color: '#64748b', marginTop: 4 },
  statsGrid: { marginTop: 10, gap: 6 },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
  statLabel: { fontSize: 13, fontWeight: '600', color: '#475569', minWidth: 88 },
  statHours: { fontSize: 13, color: '#0f172a', fontWeight: '600' },
  statPay: { fontSize: 13, color: '#64748b' },
  totalRow: { marginTop: 4, paddingTop: 8, borderTopWidth: 1, borderTopColor: '#e8eaed' },
  totalLabel: { fontSize: 14, fontWeight: '700', color: '#0f172a', minWidth: 88 },
  totalHours: { fontSize: 14, fontWeight: '700', color: '#0f172a' },
  totalPay: { fontSize: 14, fontWeight: '700', color: '#c41230' },
  muted: { textAlign: 'center', color: '#888', marginTop: 24 },
});
