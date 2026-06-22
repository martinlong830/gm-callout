import { memo, useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { EmployeeEditorSheet } from '../../components/EmployeeEditorSheet';
import { EmployeePhoto } from '../../components/EmployeePhoto';
import { useAppData } from '../../contexts/AppDataContext';
import {
  employeeClockPinLine,
  employeeDisplayName,
  employeeUsualLocationLine,
  staffTypeLabel,
  type EmployeeRow,
} from '../../lib/employees';
import { leaveSummaryLines } from '../../lib/employeeLeave';
import { loadDraftFromTeamState, SCHEDULE_TEMPLATE_WEEK_INDEX } from '../../lib/schedule/engine';
import { compareEmployeesByScheduleOrder } from '../../lib/schedule/rosterOrder';

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
}: {
  item: EmployeeRow;
  onPress: () => void;
}) {
  const pinLine = employeeClockPinLine(item);
  const leaveLines = leaveSummaryLines(item);

  return (
    <Pressable style={styles.row} onPress={onPress}>
      <View style={styles.rowMain}>
        <EmployeePhoto employee={item} size={52} />
        <View style={styles.rowBody}>
          <Text style={styles.name}>{employeeDisplayName(item)}</Text>
          <MetaRow label="Phone" value={(item.phone || '').trim() || '—'} />
          <MetaRow label="Location" value={employeeUsualLocationLine(item.usualRestaurant)} />
          {pinLine ? <MetaRow label="PIN" value={pinLine} /> : null}
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

function buildTeamRows(employees: EmployeeRow[]): TeamRow[] {
  const sorted = [...employees].sort(compareEmployeesByScheduleOrder);
  const byTitle = new Map<string, EmployeeRow[]>();
  for (const e of sorted) {
    const title = staffTypeLabel(e.staffType);
    const list = byTitle.get(title) ?? [];
    list.push(e);
    byTitle.set(title, list);
  }
  const knownOrder = ['Front of the House', 'Back of the House', 'Delivery/Dishwasher'];
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
  const { employees, teamState, loading, error, refetch } = useAppData();
  const [selected, setSelected] = useState<EmployeeRow | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const draftRows = useMemo(
    () => loadDraftFromTeamState(teamState?.draft_schedule, SCHEDULE_TEMPLATE_WEEK_INDEX),
    [teamState]
  );

  const rows = useMemo(() => buildTeamRows(employees), [employees]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);

  const renderRow = useCallback(({ item }: { item: TeamRow }) => {
    if (item.kind === 'section') {
      return <Text style={styles.sectionTitle}>{item.title}</Text>;
    }
    return <TeamMemberCard item={item.employee} onPress={() => setSelected(item.employee)} />;
  }, []);

  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <View style={styles.headerRow}>
        <Text style={styles.header}>{employees.length} people</Text>
        <Pressable
          style={styles.addBtn}
          onPress={() => {
            setSelected(null);
            setCreating(true);
          }}
        >
          <Text style={styles.addBtnText}>+ Add</Text>
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
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          contentContainerStyle={styles.scrollContent}
          ListEmptyComponent={
            !loading ? <Text style={styles.muted}>No employees in Supabase yet.</Text> : null
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
        onSaved={() => void refetch({ silent: true })}
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
