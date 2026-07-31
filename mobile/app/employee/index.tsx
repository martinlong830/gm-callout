import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CompactShiftRow } from '../../components/CompactShiftRow';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { employeeDisplayName, type EmployeeRow } from '../../lib/employees';
import { partitionShiftsByWeekStart } from '../../lib/schedule/employeeShiftDisplay';
import {
  assignmentShell,
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  getWorkerScheduleBuckets,
  hydrateScheduleAssignmentsFromTeamState,
  SCHEDULE_VIEW_WEEK_COUNT,
} from '../../lib/schedule/engine';
import type { EmployeeLite, RoleKey } from '../../lib/schedule/types';
import { formatStaffRequestSubmittedDate, type StaffRequestUi } from '../../lib/staffRequests';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: e.staffType as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
    meta: e.meta,
  };
}

function requestTypeLabel(r: StaffRequestUi, t: ReturnType<typeof useI18n>['t']): string {
  if (r.type === 'availability') return t('employee.requestAvailability');
  if (r.type === 'timeoff') return t('employee.requestTimeOff');
  if (r.type === 'swap') return t('employee.requestSwap');
  if (r.type === 'callout_request' || r.type === 'callout') return t('employee.requestCallout');
  return r.type;
}

export default function EmployeeHome() {
  const { displayName } = useAuth();
  const { t, staffTypeLabel, statusLabel } = useI18n();
  const { myEmployee, employees, staffRequests, teamState, loading, error, refetch } = useAppData();
  const [refreshing, setRefreshing] = useState(false);
  const [upcomingWeekCursor, setUpcomingWeekCursor] = useState(0);

  const restaurants = useMemo(() => defaultRestaurants(), []);
  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);

  const hydrated = useMemo(() => {
    try {
      return hydrateScheduleAssignmentsFromTeamState(
        teamState?.schedule_assignments,
        restaurants,
        teamState?.draft_schedule
      );
    } catch (err) {
      console.warn('employee home assignmentStore', err);
      return {
        store: assignmentShell(restaurants),
        draftSchedule: teamState?.draft_schedule,
        changed: false,
      };
    }
  }, [teamState?.schedule_assignments, teamState?.draft_schedule, restaurants]);
  const assignmentStore = hydrated.store;
  const draftScheduleRaw = hydrated.draftSchedule ?? teamState?.draft_schedule;

  const lites = useMemo(() => employees.map(toLite), [employees]);

  const workerName = useMemo(() => {
    if (myEmployee) return employeeDisplayName(myEmployee);
    return displayName.trim();
  }, [myEmployee, displayName]);

  // Push must never load at cold start. Expo Router sync-loads this route module
  // when the root Stack mounts, so avoid any static import of push/notifications.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      void import('../../lib/pushNotifications')
        .then((m) => {
          if (!cancelled) m.scheduleDevicePushTokenRegistration(0);
        })
        .catch((err) => console.warn('pushNotifications dynamic import', err));
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, []);

  const buckets = useMemo(() => {
    if (!workerName) return { today: [], upcoming: [] };
    try {
      return getWorkerScheduleBuckets({
        workerName,
        weekMeta,
        allWeekDays,
        draftScheduleRaw,
        employees: lites,
        restaurants,
        assignmentStore,
        schedulePublishedRaw: teamState?.schedule_published,
      });
    } catch (err) {
      console.warn('employee home schedule buckets', err);
      return { today: [], upcoming: [] };
    }
  }, [
    workerName,
    weekMeta,
    allWeekDays,
    draftScheduleRaw,
    teamState?.schedule_published,
    lites,
    restaurants,
    assignmentStore,
  ]);

  const upcomingGrouped = useMemo(
    () => partitionShiftsByWeekStart(buckets.upcoming),
    [buckets.upcoming]
  );

  const upcomingWeekRows = useMemo(() => {
    const wk = upcomingGrouped.order[upcomingWeekCursor];
    return wk ? upcomingGrouped.byWeek[wk] ?? [] : [];
  }, [upcomingGrouped, upcomingWeekCursor]);

  const recentRequests = useMemo(() => {
    const self = workerName.trim().toLowerCase();
    if (!self) return [];
    return staffRequests
      .filter(
        (r) =>
          r.type !== 'availability' &&
          String(r.employeeName || '')
            .trim()
            .toLowerCase() === self
      )
      .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))
      .slice(0, 8);
  }, [staffRequests, workerName]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch({ silent: true }).finally(() => setRefreshing(false));
  }, [refetch]);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#c41230" />}
      nestedScrollEnabled
    >
      <Text style={styles.h1}>{t('employee.welcomeTitle')}</Text>
      <Text style={styles.sub}>{displayName}</Text>
      {myEmployee ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>{t('employee.yourRole')}</Text>
          <Text style={styles.body}>{staffTypeLabel(myEmployee.staffType)}</Text>
        </View>
      ) : (
        <View style={styles.card}>
          <Text style={styles.warn}>{t('employee.noRosterLinked')}</Text>
        </View>
      )}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('employee.scheduleSection')}</Text>
        {loading && !teamState ? <Text style={styles.muted}>{t('employee.loadingSupabase')}</Text> : null}
        {error ? <Text style={styles.err}>{error}</Text> : null}
        {!loading && !teamState ? (
          <Text style={styles.muted}>{t('employee.scheduleUnavailable')}</Text>
        ) : null}
        {teamState ? (
          <>
            <Text style={styles.sectionLabel}>{t('common.today')}</Text>
            {!buckets.today.length ? (
              <Text style={styles.muted}>{t('employee.noShiftsToday')}</Text>
            ) : (
              buckets.today.map((row) => (
                <CompactShiftRow key={`t-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />
              ))
            )}
            <View style={styles.upcomingHead}>
              <Text style={[styles.sectionLabel, styles.sectionSpaced]}>{t('employee.upcomingShifts')}</Text>
              {upcomingGrouped.order.length ? (
                <ScheduleWeekPicker
                  mode="pager"
                  weekMeta={weekMeta}
                  weekStartIsos={upcomingGrouped.order}
                  cursor={upcomingWeekCursor}
                  onCursorChange={setUpcomingWeekCursor}
                />
              ) : null}
            </View>
            {!upcomingGrouped.order.length ? (
              <Text style={styles.muted}>{t('employee.noLaterShifts')}</Text>
            ) : !upcomingWeekRows.length ? (
              <Text style={styles.muted}>{t('employee.noShiftsThisWeek')}</Text>
            ) : (
              upcomingWeekRows.map((row) => (
                <CompactShiftRow key={`u-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />
              ))
            )}
          </>
        ) : null}
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('employee.recentRequests')}</Text>
        {loading && !staffRequests.length ? <Text style={styles.muted}>{t('common.loading')}</Text> : null}
        {!loading && !recentRequests.length ? (
          <Text style={styles.muted}>{t('employee.noRequestsYet')}</Text>
        ) : null}
        {recentRequests.map((r) => (
          <View key={r.id} style={styles.reqRow}>
            <Text style={styles.reqType}>{requestTypeLabel(r, t)}</Text>
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
  upcomingHead: { marginTop: 4 },
  body: { fontSize: 15, color: '#333', lineHeight: 22 },
  warn: { fontSize: 14, color: '#8a5a00', lineHeight: 20 },
  muted: { fontSize: 14, color: '#888', marginTop: 4 },
  err: { color: '#b00020', marginTop: 8 },
  reqRow: { borderTopWidth: 1, borderTopColor: '#eee', paddingTop: 10, marginTop: 10 },
  reqType: { fontWeight: '600', color: '#111' },
  reqMeta: { fontSize: 12, color: '#888', marginTop: 2 },
  reqSum: { fontSize: 14, color: '#444', marginTop: 4 },
});
