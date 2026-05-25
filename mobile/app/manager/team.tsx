import { useMemo, useState } from 'react';
import { Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { AvailabilityMatrixReadOnly } from '../../components/AvailabilityMatrixReadOnly';
import { useAppData } from '../../contexts/AppDataContext';
import {
  employeeDisplayName,
  employeeUsualLocationLine,
  staffTypeLabel,
  type EmployeeRow,
} from '../../lib/employees';
import { leaveSummaryLines } from '../../lib/employeeLeave';
import { loadDraftFromTeamState } from '../../lib/schedule/engine';
import { compareEmployeesByScheduleOrder } from '../../lib/schedule/rosterOrder';

export default function ManagerTeam() {
  const { height: windowHeight } = useWindowDimensions();
  const { employees, teamState, loading, error, refetch } = useAppData();
  const [selected, setSelected] = useState<EmployeeRow | null>(null);
  const sheetScrollMax = Math.round(windowHeight * 0.82);

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
            {sec.list.map((item) => {
              const leaveLines = leaveSummaryLines(item);
              return (
                <Pressable key={item.id} style={styles.row} onPress={() => setSelected(item)}>
                  <Text style={styles.name}>{employeeDisplayName(item)}</Text>
                  <Text style={styles.phone}>{(item.phone || '').trim() || '—'}</Text>
                  <Text style={styles.loc}>Location: {employeeUsualLocationLine(item.usualRestaurant)}</Text>
                  <View style={styles.leaveBlock}>
                    {leaveLines.slice(0, 2).map((line) => (
                      <Text key={line} style={styles.leaveLine}>
                        {line}
                      </Text>
                    ))}
                  </View>
                  {item.authUserId ? (
                    <Text style={styles.badge}>Linked login</Text>
                  ) : (
                    <Text style={styles.noLogin}>No login</Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ))}
        {!loading && !employees.length ? (
          <Text style={styles.muted}>No employees in Supabase yet.</Text>
        ) : null}
      </ScrollView>

      <Modal visible={!!selected} animationType="slide" transparent>
        <Pressable style={styles.modalBackdrop} onPress={() => setSelected(null)}>
          <View style={styles.modalPanel}>
            {selected ? (
              <ScrollView
                style={[styles.modalScroll, { maxHeight: sheetScrollMax }]}
                contentContainerStyle={styles.modalScrollContent}
                nestedScrollEnabled
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
              >
                <Text style={styles.modalTitle}>{employeeDisplayName(selected)}</Text>
                <Text style={styles.modalLine}>{staffTypeLabel(selected.staffType)}</Text>
                <Text style={styles.modalLine}>Phone: {(selected.phone || '').trim() || '—'}</Text>
                <Text style={styles.modalLine}>
                  Location: {employeeUsualLocationLine(selected.usualRestaurant)}
                </Text>
                <Text style={styles.modalLine}>
                  Login: {selected.authUserId ? 'Linked to app account' : 'Not linked'}
                </Text>
                <Text style={styles.gridLabel}>Vacation &amp; sick days</Text>
                <Text style={styles.leaveHint}>8 hours per day unless noted on a row.</Text>
                {leaveSummaryLines(selected).map((line) => (
                  <Text key={line} style={styles.leaveDetailLine}>
                    {line}
                  </Text>
                ))}
                <Text style={styles.gridLabel}>Weekly availability</Text>
                <AvailabilityMatrixReadOnly
                  weeklyGrid={(selected.weeklyGrid ?? {}) as Record<string, unknown>}
                  staffType={selected.staffType}
                  draftRows={draftRows}
                  embedInParentScroll
                />
                <Pressable style={styles.closeBtn} onPress={() => setSelected(null)}>
                  <Text style={styles.closeBtnText}>Close</Text>
                </Pressable>
              </ScrollView>
            ) : null}
          </View>
        </Pressable>
      </Modal>
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
  name: { fontSize: 16, fontWeight: '600', color: '#111' },
  phone: { fontSize: 14, color: '#475569', marginTop: 6 },
  loc: { fontSize: 13, color: '#64748b', marginTop: 4 },
  leaveBlock: {
    marginTop: 8,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#e8eaed',
  },
  leaveLine: { fontSize: 12, color: '#334155', lineHeight: 18 },
  leaveHint: { fontSize: 12, color: '#64748b', marginTop: 4, marginBottom: 6 },
  leaveDetailLine: { fontSize: 14, color: '#334155', marginTop: 4, lineHeight: 20 },
  badge: { fontSize: 12, color: '#047857', marginTop: 8, fontWeight: '600' },
  noLogin: { fontSize: 12, color: '#888', marginTop: 8 },
  muted: { fontSize: 14, color: '#888', padding: 16 },
  err: { color: '#b00020', padding: 12 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  modalPanel: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    paddingHorizontal: 20,
    paddingTop: 16,
    paddingBottom: 8,
    maxHeight: '92%',
    width: '100%',
  },
  modalScroll: {},
  modalScrollContent: { paddingBottom: 24 },
  modalTitle: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  modalLine: { fontSize: 15, color: '#334155', marginTop: 10 },
  gridLabel: { fontSize: 12, fontWeight: '700', color: '#64748b', marginTop: 16, textTransform: 'uppercase' },
  closeBtn: { marginTop: 16, paddingVertical: 12, alignItems: 'center' },
  closeBtnText: { fontSize: 16, color: '#c41230', fontWeight: '700' },
});
