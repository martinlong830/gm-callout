import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  InteractionManager,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
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
import { loadWeekExtrasSlice, type WeekExtrasSlice } from '../../../lib/timecards/weekExtras';
import {
  loadTimecardsLocationFilter,
  saveTimecardsLocationFilter,
  TIMECARDS_LOCATION_OPTIONS,
  type SelectedRestaurant,
} from '../../../lib/timecards/locationFilter';
import { rosterRowHasLocationActivity, rosterRowVisibleAtLocation } from '../../../lib/timecards/restaurantAttribution';
import type { EmployeeLite } from '../../../lib/schedule/types';
import { compareEmployeesByScheduleOrder } from '../../../lib/schedule/rosterOrder';
import { weekBoundsStorageKey } from '../../../lib/timecards/payWeek';
import { getSohRate, loadSohRate, saveSohRate } from '../../../lib/timecards/sohRate';
import { type EmployeeRow } from '../../../lib/employees';

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
        {row.additionalCashTip > 0 ? (
          <View style={styles.statRow}>
            <Text style={styles.statLabel}>Coverage</Text>
            <Text style={styles.statPay}>{formatPayAmount(row.additionalCashTip)}</Text>
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
  extras: WeekExtrasSlice;
  dishwasherTips: Record<string, number>;
};

/** Keep recently viewed pay weeks warm when switching back. */
const weekSlicesCache = new Map<string, WeekSlices>();
const WEEK_SLICES_CACHE_MAX = 6;

function cacheWeekSlices(slice: WeekSlices): void {
  weekSlicesCache.set(slice.key, slice);
  if (weekSlicesCache.size <= WEEK_SLICES_CACHE_MAX) return;
  const oldest = weekSlicesCache.keys().next().value;
  if (oldest != null) weekSlicesCache.delete(oldest);
}

function RosterSkeleton() {
  return (
    <View style={styles.skeletonWrap} accessibilityLabel="Loading timecards">
      {[0, 1, 2].map((i) => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonLineWide} />
          <View style={styles.skeletonLineNarrow} />
          <View style={styles.skeletonLineMid} />
        </View>
      ))}
    </View>
  );
}

export default function TimecardsRosterScreen() {
  const router = useRouter();
  const { employees, staffRequests, teamState } = useAppData();
  const {
    entries,
    loading,
    weekReady,
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
  const [showGrandTotals, setShowGrandTotals] = useState(false);
  const [sohRateText, setSohRateText] = useState(String(getSohRate()));
  const [sohRateVersion, setSohRateVersion] = useState(0);

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
    void loadSohRate().then((rate) => {
      setSohRateText(String(rate));
      setSohRateVersion((v) => v + 1);
    });
  }, []);

  const persistSohRate = useCallback(async () => {
    const applied = await saveSohRate(sohRateText);
    setSohRateText(String(applied));
    setSohRateVersion((v) => v + 1);
  }, [sohRateText]);

  useEffect(() => {
    const cached = weekSlicesCache.get(boundsKey);
    if (cached && !teamState?.updated_at) {
      setWeekSlices(cached);
      return;
    }
    let cancelled = false;
    setWeekSlices((prev) => (prev?.key === boundsKey ? prev : null));
    void Promise.all([loadWeekExtrasSlice(bounds), loadDishwasherTipsSlice(bounds)]).then(
      ([extras, dishwasherTips]) => {
        if (cancelled) return;
        const next = { key: boundsKey, extras, dishwasherTips };
        cacheWeekSlices(next);
        setWeekSlices(next);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [bounds, boundsKey, teamState?.updated_at]);

  const slicesReady = !!weekSlices && weekSlices.key === boundsKey;
  const dataReady = weekReady && locationReady && slicesReady;

  const rows = useMemo(() => {
    if (!dataReady || !weekSlices) return [];
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
      if (!emp) return true;
      return (
        rosterRowVisibleAtLocation(emp, locationFilter) || rosterRowHasLocationActivity(row)
      );
    });
  }, [
    dataReady,
    weekSlices,
    employees,
    entries,
    teamState,
    staffRequests,
    lites,
    bounds,
    locationFilter,
    employeeById,
    teamState?.updated_at,
    sohRateVersion,
  ]);

  useEffect(() => {
    if (!dataReady || !rows.length) {
      setShowGrandTotals(false);
      return;
    }
    let cancelled = false;
    const task = InteractionManager.runAfterInteractions(() => {
      if (!cancelled) setShowGrandTotals(true);
    });
    return () => {
      cancelled = true;
      task.cancel();
    };
  }, [dataReady, rows]);

  const onLocationChange = useCallback(async (next: SelectedRestaurant) => {
    setLocationFilter(next);
    await saveTimecardsLocationFilter(next);
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refresh().finally(() => setRefreshing(false));
  }, [refresh]);

  const totals = useMemo(() => computeRosterTotals(rows), [rows]);
  const initialBusy = (loading || !dataReady) && !rows.length;

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

      <View style={styles.sohRateSection}>
        <Text style={styles.locationLabel}>SoH rate</Text>
        <View style={styles.sohRateRow}>
          <Text style={styles.sohRatePrefix}>$</Text>
          <TextInput
            style={styles.sohRateInput}
            value={sohRateText}
            onChangeText={setSohRateText}
            onEndEditing={() => void persistSohRate()}
            keyboardType="decimal-pad"
            accessibilityLabel="Spread of hours rate"
          />
          <Text style={styles.sohRateSuffix}>/hr</Text>
        </View>
      </View>

      {error ? <Text style={styles.err}>{error}</Text> : null}

      {initialBusy ? (
        <>
          <ActivityIndicator style={styles.spinner} color="#c41230" />
          <RosterSkeleton />
        </>
      ) : null}

      {!initialBusy && showGrandTotals && rows.length > 0 ? (
        <GrandTotalsSection totals={totals} bounds={bounds} locationFilter={locationFilter} />
      ) : null}

      <View style={styles.list}>
        {!initialBusy
          ? rows.map((row) => {
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
            })
          : null}
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
  sohRateSection: { paddingHorizontal: 16, paddingBottom: 10 },
  sohRateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: 180,
  },
  sohRatePrefix: { fontSize: 16, fontWeight: '600', color: '#475569' },
  sohRateSuffix: { fontSize: 14, color: '#64748b' },
  sohRateInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 16,
    backgroundColor: '#fff',
    color: '#0f172a',
  },
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
  spinner: { marginTop: 24, marginBottom: 8 },
  skeletonWrap: { paddingHorizontal: 16, gap: 10, marginBottom: 8 },
  skeletonCard: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    gap: 10,
  },
  skeletonLineWide: {
    height: 14,
    width: '55%',
    borderRadius: 4,
    backgroundColor: '#e8eaed',
  },
  skeletonLineNarrow: {
    height: 10,
    width: '35%',
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
  },
  skeletonLineMid: {
    height: 10,
    width: '70%',
    borderRadius: 4,
    backgroundColor: '#f1f5f9',
  },
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
  clockBreak: { backgroundColor: '#fef3c7', color: '#b45309' },
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
