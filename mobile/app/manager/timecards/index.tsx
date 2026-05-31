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
import { useAppData } from '../../../contexts/AppDataContext';
import { useTimecards } from '../../../contexts/TimecardsContext';
import { employeeDisplayName, type EmployeeRow } from '../../../lib/employees';
import {
  buildAllRosterRows,
  decimalHoursFromMinutes,
  formatPayAmount,
  statusColor,
  type RosterRow,
} from '../../../lib/timecards/engine';
import { getPayWeekBounds } from '../../../lib/timecards/payWeek';
import { loadWeekExtrasSlice } from '../../../lib/timecards/weekExtras';
import type { EmployeeLite } from '../../../lib/schedule/types';
import { compareEmployeesByScheduleOrder } from '../../../lib/schedule/rosterOrder';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as EmployeeLite['staffType'],
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

export default function TimecardsRosterScreen() {
  const router = useRouter();
  const { employees, staffRequests, teamState } = useAppData();
  const { entries, loading, error, weekLabel, refresh } = useTimecards();
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(false);

  const lites = useMemo(() => employees.map(toLite), [employees]);

  const loadRows = useCallback(async () => {
    setRowsLoading(true);
    const extrasSlice = await loadWeekExtrasSlice(getPayWeekBounds());
    const built = buildAllRosterRows(employees, entries, teamState, staffRequests, lites, extrasSlice);
    built.sort((a, b) => {
      const empA = employees.find((e) => e.id === a.empId);
      const empB = employees.find((e) => e.id === b.empId);
      if (empA && empB) return compareEmployeesByScheduleOrder(empA, empB);
      const d = a.deptRank - b.deptRank;
      if (d !== 0) return d;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    setRows(built);
    setRowsLoading(false);
  }, [employees, entries, teamState, staffRequests, lites]);

  useEffect(() => {
    if (!loading) void loadRows();
  }, [loading, loadRows]);

  const busy = loading || rowsLoading;

  const grandTotals = useMemo(() => {
    let grandTotalPay = 0;
    let hasGrandTotal = false;
    for (const row of rows) {
      if (row.grandTotalPay != null) {
        grandTotalPay += row.grandTotalPay;
        hasGrandTotal = true;
        continue;
      }
      let rowSum = 0;
      let rowHas = false;
      if (row.regPay != null) {
        rowSum += row.regPay;
        rowHas = true;
      }
      if (row.otPay != null) {
        rowSum += row.otPay;
        rowHas = true;
      }
      if (row.sohPay != null) {
        rowSum += row.sohPay;
        rowHas = true;
      }
      if (rowHas) {
        grandTotalPay += rowSum;
        hasGrandTotal = true;
      }
    }
    return { grandTotalPay, hasGrandTotal };
  }, [rows]);

  return (
    <View style={styles.screen}>
      <Text style={styles.week}>Pay week: {weekLabel}</Text>
      {!busy && rows.length ? (
        <View style={styles.grandTotals}>
          <Text style={styles.grandTotalsLabel}>Total pay</Text>
          <Text style={styles.grandTotalsValue}>
            {grandTotals.hasGrandTotal ? formatPayAmount(grandTotals.grandTotalPay) : '—'}
          </Text>
          <Text style={styles.grandTotalsMeta}>{rows.length} employees</Text>
        </View>
      ) : null}
      {error ? <Text style={styles.err}>{error}</Text> : null}
      {busy && !rows.length ? (
        <ActivityIndicator style={styles.spinner} color="#c41230" />
      ) : (
        <ScrollView
          refreshControl={
            <RefreshControl
              refreshing={busy}
              onRefresh={() => {
                void refresh().then(() => loadRows());
              }}
              tintColor="#c41230"
            />
          }
          contentContainerStyle={styles.list}
        >
          {rows.map((row) => {
            const sc = statusColor(row.status);
            return (
              <Pressable
                key={row.empId}
                style={styles.card}
                onPress={() =>
                  router.push({
                    pathname: '/manager/timecards/[employeeId]',
                    params: { employeeId: row.empId },
                  })
                }
              >
                <View style={styles.cardTop}>
                  <Text style={styles.name}>{row.name}</Text>
                  <View style={[styles.badge, { backgroundColor: sc.bg }]}>
                    <Text style={[styles.badgeText, { color: sc.text }]}>{row.status}</Text>
                  </View>
                </View>
                <Text style={styles.role}>{row.role}</Text>
                <View style={styles.stats}>
                  <Text style={styles.stat}>
                    Reg {decimalHoursFromMinutes(row.regMins)}h · {formatPayAmount(row.regPay)}
                  </Text>
                  <Text style={styles.stat}>
                    OT {decimalHoursFromMinutes(row.otMins)}h · {formatPayAmount(row.otPay)}
                  </Text>
                  <Text style={styles.stat}>
                    VL {row.vlHours.toFixed(1)}h · SL {row.slHours.toFixed(1)}h · SoH {row.sohCount}
                  </Text>
                  <Text style={styles.total}>Total {formatPayAmount(row.grandTotalPay)}</Text>
                </View>
              </Pressable>
            );
          })}
          {!busy && !employees.length ? (
            <Text style={styles.muted}>No employees on the roster.</Text>
          ) : null}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  week: { paddingHorizontal: 16, paddingTop: 12, fontSize: 14, fontWeight: '600', color: '#334155' },
  grandTotals: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    padding: 14,
    borderRadius: 10,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  grandTotalsLabel: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  grandTotalsValue: { fontSize: 24, fontWeight: '700', color: '#0f172a', marginTop: 2 },
  grandTotalsMeta: { fontSize: 12, color: '#94a3b8', marginTop: 4 },
  err: { color: '#b91c1c', padding: 16 },
  spinner: { marginTop: 40 },
  list: { padding: 16, paddingBottom: 32, gap: 10 },
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
  stats: { marginTop: 10, gap: 4 },
  stat: { fontSize: 13, color: '#475569' },
  total: { fontSize: 15, fontWeight: '700', color: '#c41230', marginTop: 4 },
  muted: { textAlign: 'center', color: '#888', marginTop: 24 },
});
