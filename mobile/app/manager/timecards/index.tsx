import { useFocusEffect, useRouter } from 'expo-router';
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
import { GrandTotalsSection } from '../../../components/timecards/GrandTotalsSection';
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import {
  buildAllRosterRows,
  computeRosterTotals,
  decimalHoursFromMinutes,
  formatPayAmount,
  formatSoHDatesList,
  computeSpreadOfHours,
  type RosterRow,
} from '../../../lib/timecards/engine';
import { loadDishwasherTipsSlice } from '../../../lib/timecards/dishwasherTips';
import { loadWeekExtrasSlice } from '../../../lib/timecards/weekExtras';
import type { EmployeeLite } from '../../../lib/schedule/types';
import { compareEmployeesByScheduleOrder } from '../../../lib/schedule/rosterOrder';
import { type EmployeeRow } from '../../../lib/employees';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function RosterRowCard({
  row,
  emp,
  entries,
  onPress,
}: {
  row: RosterRow;
  emp: EmployeeRow;
  entries: ReturnType<typeof useTimecards>['entries'];
  onPress: () => void;
}) {
  const soh = computeSpreadOfHours(emp, entries);
  return (
    <Pressable style={styles.card} onPress={onPress}>
      <View style={styles.cardTop}>
        <Text style={styles.name}>{row.name}</Text>
      </View>
      <Text style={styles.role}>{row.role}</Text>
      <View style={styles.statsGrid}>
        <Text style={styles.stat}>
          Sched {decimalHoursFromMinutes(row.schedMins)}h
        </Text>
        <Text style={styles.stat}>
          Reg {decimalHoursFromMinutes(row.regMins)}h · {formatPayAmount(row.regPay)}
        </Text>
        <Text style={styles.stat}>
          OT {decimalHoursFromMinutes(row.otMins)}h · {formatPayAmount(row.otPay)}
        </Text>
        <Text style={styles.stat}>
          VL {row.vlHours.toFixed(1)}h · SL {row.slHours.toFixed(1)}h
        </Text>
        <Text style={styles.stat}>
          SoH {row.sohCount} · {formatSoHDatesList(soh.dates)}
        </Text>
        {row.dishwasherTipsPay > 0 ? (
          <Text style={styles.stat}>Dishwasher tips {formatPayAmount(row.dishwasherTipsPay)}</Text>
        ) : null}
        <Text style={styles.total}>Total {formatPayAmount(row.grandTotalPay)}</Text>
      </View>
    </Pressable>
  );
}

export default function TimecardsRosterScreen() {
  const router = useRouter();
  const { employees, staffRequests, teamState } = useAppData();
  const {
    entries,
    loading,
    error,
    bounds,
    weekLabel,
    payWeekOptions,
    selectedWeekStartIso,
    setPayWeekStartIso,
    refresh,
  } = useTimecards();
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);

  const lites = useMemo(() => employees.map(toLite), [employees]);

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    const [extrasSlice, dishwasherTipsSlice] = await Promise.all([
      loadWeekExtrasSlice(bounds),
      loadDishwasherTipsSlice(bounds),
    ]);
    const built = buildAllRosterRows(
      employees,
      entries,
      teamState,
      staffRequests,
      lites,
      extrasSlice,
      dishwasherTipsSlice,
      bounds
    );
    built.sort((a, b) => {
      const empA = employees.find((e) => e.id === a.empId);
      const empB = employees.find((e) => e.id === b.empId);
      if (empA && empB) return compareEmployeesByScheduleOrder(empA, empB);
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    setRows(built);
    setRowsLoading(false);
  }, [employees, entries, teamState, staffRequests, lites, bounds]);

  useEffect(() => {
    if (!loading) void loadRows();
  }, [loading, loadRows]);

  useFocusEffect(
    useCallback(() => {
      if (!loading) void loadRows();
    }, [loading, loadRows])
  );

  const totals = useMemo(() => computeRosterTotals(rows), [rows]);
  const busy = loading || rowsLoading;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.scrollContent}
      showsVerticalScrollIndicator
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      refreshControl={
        <RefreshControl
          refreshing={busy}
          onRefresh={() => {
            void refresh().then(() => loadRows());
          }}
          tintColor="#c41230"
        />
      }
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        nestedScrollEnabled
        style={styles.weekPickerScroll}
        contentContainerStyle={styles.weekPicker}
      >
        {payWeekOptions.map((opt) => {
          const on = opt.startIso === selectedWeekStartIso;
          return (
            <Pressable
              key={opt.startIso}
              style={[styles.weekChip, on && styles.weekChipOn]}
              onPress={() => void setPayWeekStartIso(opt.startIso)}
            >
              <Text style={[styles.weekChipText, on && styles.weekChipTextOn]} numberOfLines={2}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <Text style={styles.weekLabel}>Pay week: {weekLabel}</Text>
      {error ? <Text style={styles.err}>{error}</Text> : null}

      {busy && !rows.length ? (
        <ActivityIndicator style={styles.spinner} color="#c41230" />
      ) : null}

      {!busy && rows.length ? (
        <GrandTotalsSection totals={totals} bounds={bounds} />
      ) : null}

      <View style={styles.list}>
        {rows.map((row) => {
          const emp = employees.find((e) => e.id === row.empId);
          if (!emp) return null;
          return (
            <RosterRowCard
              key={row.empId}
              row={row}
              emp={emp}
              entries={entries}
              onPress={() =>
                router.push({
                  pathname: '/manager/timecards/[employeeId]',
                  params: { employeeId: row.empId },
                })
              }
            />
          );
        })}
        {!busy && !employees.length ? (
          <Text style={styles.muted}>No employees on the roster.</Text>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  scrollContent: { paddingBottom: 32 },
  weekPickerScroll: { maxHeight: 56, flexGrow: 0 },
  weekPicker: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  weekChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    maxWidth: 200,
  },
  weekChipOn: { borderColor: '#c41230', backgroundColor: '#fef2f2' },
  weekChipText: { fontSize: 12, color: '#475569' },
  weekChipTextOn: { color: '#c41230', fontWeight: '700' },
  weekLabel: { paddingHorizontal: 16, paddingBottom: 4, fontSize: 13, color: '#64748b' },
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
  badge: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  badgeText: { fontSize: 12, fontWeight: '700' },
  role: { fontSize: 13, color: '#64748b', marginTop: 4 },
  statsGrid: { marginTop: 10, gap: 4 },
  stat: { fontSize: 13, color: '#475569' },
  total: { fontSize: 15, fontWeight: '700', color: '#c41230', marginTop: 6 },
  muted: { textAlign: 'center', color: '#888', marginTop: 24 },
});
