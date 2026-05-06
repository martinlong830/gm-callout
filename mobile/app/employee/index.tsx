import { useFocusEffect } from '@react-navigation/native';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { employeeDisplayName, staffTypeLabel, type EmployeeRow } from '../../lib/employees';
import {
  assignmentShell,
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getThisMondayDate,
  getWorkerScheduleBuckets,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  SCHEDULE_VIEW_WEEK_COUNT,
  type WorkerShiftRow,
} from '../../lib/schedule/engine';
import type { EmployeeLite, RoleKey } from '../../lib/schedule/types';
import { formatStaffRequestSubmittedDate, type StaffRequestUi } from '../../lib/staffRequests';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function requestTypeLabel(r: StaffRequestUi): string {
  if (r.type === 'availability') return 'Availability';
  if (r.type === 'timeoff') return 'Time off';
  if (r.type === 'swap') return 'Shift swap';
  if (r.type === 'callout_request' || r.type === 'callout') return 'Callout';
  return r.type;
}

function statusLabel(status: string): string {
  if (status === 'approved') return 'Approved';
  if (status === 'declined') return 'Declined';
  return 'Pending';
}

function ShiftLine({ row }: { row: WorkerShiftRow }) {
  const day = row.dayNameUpper || row.day;
  return (
    <View style={styles.shiftRow}>
      <Text style={styles.shiftDay}>{day}</Text>
      <Text style={styles.shiftTime}>{row.timeLabel}</Text>
      <Text style={styles.shiftMeta}>
        {row.groupLabel} · {row.restaurantName}
      </Text>
    </View>
  );
}

export default function EmployeeHome() {
  const { displayName } = useAuth();
  const { myEmployee, employees, staffRequests, teamState, loading, error, refetch } = useAppData();
  const [refreshing, setRefreshing] = useState(false);

  const restaurants = useMemo(() => defaultRestaurants(), []);
  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getThisMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);

  const draftRows = useMemo(() => loadDraftFromTeamState(teamState?.draft_schedule), [teamState]);

  const assignmentStore = useMemo(() => {
    const ids = restaurants.map((r) => r.id);
    const shell = assignmentShell(restaurants);
    return mergeRemoteAssignments(shell, teamState?.schedule_assignments, ids);
  }, [teamState, restaurants]);

  const lites = useMemo(() => employees.map(toLite), [employees]);

  const workerName = useMemo(() => {
    if (myEmployee) return employeeDisplayName(myEmployee);
    return displayName.trim();
  }, [myEmployee, displayName]);

  const buckets = useMemo(() => {
    if (!workerName) return { today: [] as WorkerShiftRow[], upcoming: [] as WorkerShiftRow[] };
    return getWorkerScheduleBuckets({
      workerName,
      weekMeta,
      allWeekDays,
      draftRows,
      employees: lites,
      restaurants,
      assignmentStore,
    });
  }, [workerName, weekMeta, allWeekDays, draftRows, lites, restaurants, assignmentStore]);

  /** RLS limits employees to their own `staff_requests` rows — same source as web. */
  const recentRequests = useMemo(() => staffRequests.slice(0, 8), [staffRequests]);

  useFocusEffect(
    useCallback(() => {
      void refetch();
    }, [refetch])
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);

  const upcomingPreview = useMemo(() => buckets.upcoming.slice(0, 14), [buckets.upcoming]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#c41230" />}
    >
      <Text style={styles.h1}>Welcome</Text>
      <Text style={styles.sub}>{displayName}</Text>
      {myEmployee ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Your role</Text>
          <Text style={styles.body}>{staffTypeLabel(myEmployee.staffType)}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.warn}>
            No roster row linked to your account yet. Ask a manager to connect your auth user in Employees, or
            complete employee registration on the web.
          </Text>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Schedule</Text>
        {loading && !teamState ? <Text style={styles.muted}>Loading from Supabase…</Text> : null}
        {error ? <Text style={styles.err}>{error}</Text> : null}
        {!loading && !teamState ? (
          <Text style={styles.muted}>Schedule data is not available yet. Pull to refresh.</Text>
        ) : null}
        {teamState ? (
          <>
            <Text style={styles.sectionLabel}>Today</Text>
            {!buckets.today.length ? (
              <Text style={styles.muted}>No shifts scheduled for you today in the published window.</Text>
            ) : (
              buckets.today.map((row) => <ShiftLine key={`t-${row.restaurantId}-${row.id}`} row={row} />)
            )}
            <Text style={[styles.sectionLabel, styles.sectionSpaced]}>Upcoming</Text>
            {!upcomingPreview.length ? (
              <Text style={styles.muted}>No upcoming shifts in the next few weeks.</Text>
            ) : (
              upcomingPreview.map((row) => <ShiftLine key={`u-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />)
            )}
          </>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>Your recent requests</Text>
        {loading && !staffRequests.length ? <Text style={styles.muted}>Loading…</Text> : null}
        {!loading && !recentRequests.length ? (
          <Text style={styles.muted}>No requests yet. Use the Actions tab.</Text>
        ) : null}
        {recentRequests.map((r) => (
          <View key={r.id} style={styles.reqRow}>
            <Text style={styles.reqType}>{requestTypeLabel(r)}</Text>
            <Text style={styles.reqMeta}>
              {statusLabel(r.status)} · {formatStaffRequestSubmittedDate(r.submittedAt)}
            </Text>
            <Text style={styles.reqSum} numberOfLines={3}>
              {r.summary}
            </Text>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 32 },
  h1: { fontSize: 22, fontWeight: '700', color: '#111' },
  sub: { fontSize: 15, color: '#555', marginTop: 4, marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  cardTitle: { fontSize: 12, fontWeight: '700', color: '#666', marginBottom: 8, textTransform: 'uppercase' },
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#64748b', letterSpacing: 0.5, marginTop: 4 },
  sectionSpaced: { marginTop: 14 },
  body: { fontSize: 15, color: '#333', lineHeight: 22 },
  warn: { fontSize: 14, color: '#8a5a00', lineHeight: 20 },
  muted: { fontSize: 14, color: '#888', marginTop: 4 },
  err: { color: '#b00020', marginTop: 8 },
  shiftRow: {
    borderTopWidth: 1,
    borderTopColor: '#eee',
    paddingTop: 10,
    marginTop: 10,
  },
  shiftDay: { fontSize: 13, fontWeight: '700', color: '#0f172a' },
  shiftTime: { fontSize: 15, fontWeight: '600', color: '#111', marginTop: 2 },
  shiftMeta: { fontSize: 13, color: '#64748b', marginTop: 4 },
  reqRow: { borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 10, marginTop: 10 },
  reqType: { fontWeight: '600', color: '#111' },
  reqMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  reqSum: { fontSize: 14, color: '#444', marginTop: 4 },
});
