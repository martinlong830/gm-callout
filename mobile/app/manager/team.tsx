import { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
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
import { loadDraftFromTeamState } from '../../lib/schedule/engine';
import { compareEmployeesByScheduleOrder } from '../../lib/schedule/rosterOrder';

function MetaRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={styles.metaValue}>{value}</Text>
    </View>
  );
}

function TeamMemberCard({ item, onPress }: { item: EmployeeRow; onPress: () => void }) {
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
}

export default function ManagerTeam() {
  const { employees, teamState, loading, error, refetch } = useAppData();
  const [selected, setSelected] = useState<EmployeeRow | null>(null);

  const draftRows = useMemo(() => loadDraftFromTeamState(teamState?.draft_schedule), [teamState]);

  const sorted = [...employees].sort(compareEmployeesByScheduleOrder);

  const sections: { title: string; list: EmployeeRow[] }[] = [];
  let curTitle = '';
  let bucket: EmployeeRow[] = [];
  for (const e of sorted) {
    const title = staffTypeLabel(e.staffType);
    if (title !== curTitle) {
      if (bucket.length) sections.push({ title: curTitle, list: bucket });
      curTitle = title;
      bucket = [e];
    } else {
      bucket.push(e);
    }
  }
  if (bucket.length) sections.push({ title: curTitle, list: bucket });

  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <Text style={styles.header}>{employees.length} people</Text>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={() => void refetch()} tintColor="#c41230" />
        }
        contentContainerStyle={styles.scrollContent}
      >
        {sections.map((sec) => (
          <View key={sec.title}>
            <Text style={styles.sectionTitle}>{sec.title}</Text>
            {sec.list.map((item) => (
              <TeamMemberCard key={item.id} item={item} onPress={() => setSelected(item)} />
            ))}
          </View>
        ))}
        {!loading && !employees.length ? (
          <Text style={styles.muted}>No employees in Supabase yet.</Text>
        ) : null}
      </ScrollView>

      <EmployeeEditorSheet
        employee={selected}
        visible={!!selected}
        draftRows={draftRows}
        onClose={() => setSelected(null)}
        onSaved={() => void refetch()}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  header: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4, fontSize: 14, color: '#666' },
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
