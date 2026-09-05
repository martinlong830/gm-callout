import { Redirect } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { HomeScheduleSections } from '../../components/HomeScheduleSections';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { normalizeCompanyHolidays } from '../../lib/companyHolidays';
import { employeeDisplayName, type EmployeeRow } from '../../lib/employees';
import { isAdminRole } from '../../lib/roles';
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

/** Manager home — own upcoming shifts (same SoT as employee home). */
export default function ManagerHome() {
  const { displayName, role } = useAuth();
  const { t, staffTypeLabel } = useI18n();
  const { myEmployee, employees, teamState, loading, error, refetch } = useAppData();
  const [refreshing, setRefreshing] = useState(false);

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
      console.warn('manager home assignmentStore', err);
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

  const buckets = useMemo(() => {
    if (!workerName || !myEmployee) return { today: [], upcoming: [], past: [] };
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
        respectUsualRestaurant: false,
      });
    } catch (err) {
      console.warn('manager home schedule buckets', err);
      return { today: [], upcoming: [], past: [] };
    }
  }, [
    workerName,
    myEmployee,
    weekMeta,
    allWeekDays,
    draftScheduleRaw,
    teamState?.schedule_published,
    lites,
    restaurants,
    assignmentStore,
  ]);

  const holidays = useMemo(
    () => normalizeCompanyHolidays(teamState?.company_holidays),
    [teamState?.company_holidays]
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch({ silent: true }).finally(() => setRefreshing(false));
  }, [refetch]);

  if (isAdminRole(role)) {
    return <Redirect href="/manager/schedule" />;
  }

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
      ) : null}
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('employee.scheduleSection')}</Text>
        {loading && !teamState ? <Text style={styles.muted}>{t('employee.loadingSupabase')}</Text> : null}
        {error ? <Text style={styles.err}>{error}</Text> : null}
        {!loading && !teamState ? (
          <Text style={styles.muted}>{t('employee.scheduleUnavailable')}</Text>
        ) : null}
        {!myEmployee && !loading ? (
          <Text style={styles.muted}>{t('employee.noRosterLinked')}</Text>
        ) : null}
        {teamState && myEmployee ? (
          <HomeScheduleSections
            today={buckets.today}
            upcoming={buckets.upcoming}
            past={buckets.past}
            holidays={holidays}
            weekMeta={weekMeta}
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: '#f4f6f8' },
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
  cardTitle: { fontSize: 15, fontWeight: '700', color: '#111', marginBottom: 8 },
  body: { fontSize: 14, color: '#333' },
  muted: { fontSize: 14, color: '#888', marginTop: 4 },
  err: { fontSize: 14, color: '#b91c1c', marginTop: 4 },
});
