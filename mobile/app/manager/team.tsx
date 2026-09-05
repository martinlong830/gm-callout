import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import type { ErrorBoundaryProps } from 'expo-router';
import { EmployeeEditorSheet } from '../../components/EmployeeEditorSheet';
import { EmployeePhoto } from '../../components/EmployeePhoto';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import {
  employeeClockPinLine,
  employeeDisplayName,
  employeePrimaryLocationLine,
  employeeVisibleInManagerStoreScope,
  managerManagedRestaurantId,
  type EmployeeRow,
} from '../../lib/employees';
import { leaveSummaryLines } from '../../lib/employeeLeave';
import { portalListCompanyAccountRoles } from '../../lib/portalAuth';
import { isAdminRole } from '../../lib/roles';
import { loadDraftFromTeamState, SCHEDULE_TEMPLATE_WEEK_INDEX } from '../../lib/schedule/engine';
import { compareEmployeesByDisplayName } from '../../lib/schedule/rosterOrder';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

type TeamRow =
  | { key: string; kind: 'section'; title: string }
  | { key: string; kind: 'member'; employee: EmployeeRow };

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

const TeamMemberCard = memo(function TeamMemberCard({
  item,
  onPress,
  t,
  accountRoleLabel,
}: {
  item: EmployeeRow;
  onPress: () => void;
  t: (key: string) => string;
  accountRoleLabel?: string | null;
}) {
  const pinLine = employeeClockPinLine(item);
  let leaveLines: string[] = [];
  try {
    leaveLines = leaveSummaryLines(item);
  } catch (err) {
    console.warn('leaveSummaryLines', item.id, err);
  }

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowMain}>
        <EmployeePhoto employee={item} size={52} />
        <View style={styles.rowBody}>
          <Text style={styles.name}>{employeeDisplayName(item)}</Text>
          <MetaRow label={t('common.phone')} value={(item.phone || '').trim() || '—'} />
          <MetaRow label={t('team.primaryLocation')} value={employeePrimaryLocationLine(item)} />
          <MetaRow
            label={t('team.employmentStatus')}
            value={item.employmentStatus === 'full-time' ? t('team.fullTime') : t('team.partTime')}
          />
          {accountRoleLabel ? (
            <MetaRow label={t('team.accountType')} value={accountRoleLabel} />
          ) : null}
          {pinLine ? <MetaRow label={t('team.pin')} value={pinLine} /> : null}
          {leaveLines.length ? (
            <View style={styles.leaveBlock}>
              {leaveLines.slice(0, 2).map((line) => (
                <Text key={line} style={styles.leaveLine}>
                  {line}
                </Text>
              ))}
            </View>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
});

function buildTeamRows(employees: EmployeeRow[], staffTypeLabel: (code: string) => string): TeamRow[] {
  const byTitle = new Map<string, EmployeeRow[]>();
  for (const e of employees) {
    const title = staffTypeLabel(e.staffType);
    const list = byTitle.get(title) ?? [];
    list.push(e);
    byTitle.set(title, list);
  }
  for (const list of byTitle.values()) {
    list.sort(compareEmployeesByDisplayName);
  }
  const knownOrder = [
    staffTypeLabel('Bartender'),
    staffTypeLabel('Kitchen'),
    staffTypeLabel('Server'),
    staffTypeLabel(''),
  ];
  const titles = [
    ...knownOrder.filter((t) => byTitle.has(t)),
    ...[...byTitle.keys()].filter((t) => !knownOrder.includes(t)).sort(),
  ];
  const rows: TeamRow[] = [];
  for (const title of titles) {
    rows.push({ key: `sec-${title}`, kind: 'section', title });
    for (const employee of byTitle.get(title)!) {
      rows.push({ key: employee.id, kind: 'member', employee });
    }
  }
  return rows;
}

export default function ManagerTeam() {
  const { employees, teamState, loading, error, refetch, myEmployee } = useAppData();
  const { role } = useAuth();
  const { t, staffTypeLabel } = useI18n();
  const [selected, setSelected] = useState<EmployeeRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [rolesByAuthId, setRolesByAuthId] = useState<Record<string, string>>({});
  const isAdmin = isAdminRole(role);

  const draftRows = useMemo(
    () => loadDraftFromTeamState(teamState?.draft_schedule, SCHEDULE_TEMPLATE_WEEK_INDEX),
    [teamState]
  );

  const scopedEmployees = useMemo(() => {
    const scope = managerManagedRestaurantId(myEmployee, role);
    return employees.filter((e) => employeeVisibleInManagerStoreScope(e, scope));
  }, [employees, myEmployee, role]);

  const rows = useMemo(
    () => buildTeamRows(scopedEmployees, staffTypeLabel),
    [scopedEmployees, staffTypeLabel]
  );

  const loadAccountRoles = useCallback(() => {
    if (!isAdmin) {
      setRolesByAuthId({});
      return;
    }
    void portalListCompanyAccountRoles().then((res) => {
      if (!res.ok) return;
      const next: Record<string, string> = {};
      for (const a of res.accounts) {
        if (a.authUserId) next[String(a.authUserId)] = a.role;
      }
      setRolesByAuthId(next);
    });
  }, [isAdmin]);

  useEffect(() => {
    loadAccountRoles();
  }, [loadAccountRoles, employees.length]);

  const accountLabelFor = useCallback(
    (emp: EmployeeRow) => {
      if (!isAdmin) return null;
      if (emp.authUserId && rolesByAuthId[String(emp.authUserId)]) {
        const r = rolesByAuthId[String(emp.authUserId)];
        if (r === 'admin') return t('team.accountAdmin');
        if (r === 'manager') return t('team.accountManager');
        if (r === 'employee') return t('team.accountTeamMember');
        return r;
      }
      if (emp.authUserId) return t('editor.loginLinked');
      return t('team.accountNotLinked');
    },
    [isAdmin, rolesByAuthId, t]
  );

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadAccountRoles();
    void refetch().finally(() => setRefreshing(false));
  }, [refetch, loadAccountRoles]);

  const renderRow = useCallback(
    ({ item }: { item: TeamRow }) => {
      if (item.kind === 'section') {
        return <Text style={styles.sectionTitle}>{item.title}</Text>;
      }
      return (
        <TeamMemberCard
          item={item.employee}
          onPress={() => setSelected(item.employee)}
          t={t}
          accountRoleLabel={accountLabelFor(item.employee)}
        />
      );
    },
    [t, accountLabelFor]
  );

  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <View style={styles.headerRow}>
        <Text style={styles.header}>{t('team.people', { count: employees.length })}</Text>
        <Pressable
          style={styles.addBtn}
          onPress={() => {
            setSelected(null);
            setCreating(true);
          }}
        >
          <Text style={styles.addBtnText}>{t('team.add')}</Text>
        </Pressable>
      </View>
      {loading && !employees.length ? (
        <ActivityIndicator style={styles.initialLoader} />
      ) : (
        <FlatList
          style={styles.list}
          data={rows}
          keyExtractor={(item) => item.key}
          renderItem={renderRow}
          refreshing={refreshing}
          onRefresh={onRefresh}
          contentContainerStyle={styles.scrollContent}
          ListEmptyComponent={
            !loading ? <Text style={styles.muted}>{t('team.noEmployeesSupabase')}</Text> : null
          }
          keyboardShouldPersistTaps="handled"
        />
      )}

      <EmployeeEditorSheet
        employee={creating ? null : selected}
        isCreate={creating}
        visible={creating || !!selected}
        draftRows={draftRows}
        onClose={() => {
          setSelected(null);
          setCreating(false);
        }}
        onSaved={() => {
          loadAccountRoles();
          void refetch({ silent: true });
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 4,
  },
  header: { fontSize: 14, color: '#666' },
  addBtn: {
    backgroundColor: '#c41230',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
  },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 14 },
  list: { flex: 1 },
  initialLoader: { marginTop: 24 },
  scrollContent: { paddingBottom: 32 },
  sectionTitle: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    letterSpacing: 0.6,
    textTransform: 'uppercase',
    backgroundColor: '#e8ecf1',
  },
  row: {
    backgroundColor: '#fff',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaed',
  },
  rowMain: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowBody: { flex: 1, minWidth: 0 },
  name: { fontSize: 16, fontWeight: '600', color: '#111', marginBottom: 6 },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginTop: 4,
    gap: 8,
  },
  metaLabel: {
    width: 72,
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  metaValue: { flex: 1, fontSize: 14, color: '#334155' },
  leaveBlock: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e8eaed',
  },
  leaveLine: { fontSize: 12, color: '#334155', lineHeight: 18 },
  muted: { fontSize: 14, color: '#888', padding: 16 },
  err: { color: '#b00020', padding: 12 },
});
