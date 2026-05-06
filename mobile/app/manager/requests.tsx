import { useCallback, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { AvailabilityMatrixReadOnly } from '../../components/AvailabilityMatrixReadOnly';
import { useAppData } from '../../contexts/AppDataContext';
import { staffTypeLabel } from '../../lib/employees';
import { loadDraftFromTeamState } from '../../lib/schedule/engine';
import { supabase } from '../../lib/supabase';
import {
  formatStaffRequestSubmittedDate,
  isCloudStaffRequestId,
  submittedAvailabilityGridIsNonEmpty,
  type StaffRequestUi,
  updateStaffRequestStatus,
} from '../../lib/staffRequests';

type ActionTypeFilter = 'availability' | 'timeoff' | 'swap' | 'callout';
type StatusFilter = 'all' | 'pending' | 'closed';

type CalloutHistoryEntry = {
  shift: {
    day?: string;
    timeLabel?: string;
    groupLabel?: string;
    role?: string;
    roleClass?: string;
    start?: string;
    end?: string;
  };
  status?: string;
  acceptedBy?: { name?: string; role?: string } | null;
  notified?: string[];
  noResponse?: string[];
  contactMethod?: string | null;
  originalWorkers?: string[];
  restaurantName?: string | null;
  voiceConfirmed?: boolean;
};

function parseCalloutHistory(raw: unknown): CalloutHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is CalloutHistoryEntry =>
      !!e && typeof e === 'object' && !!(e as CalloutHistoryEntry).shift && typeof (e as CalloutHistoryEntry).shift === 'object'
  );
}

function calloutContactLabel(method: string | null | undefined): string {
  if (method === 'call') return 'Phone call';
  if (method === 'text') return 'Text';
  return method ? String(method) : '—';
}

function coverageStatusLine(item: CalloutHistoryEntry): { word: string; tone: 'pending' | 'ok' | 'muted' } {
  if (item.status === 'pending') return { word: 'Awaiting response', tone: 'pending' };
  if (item.status === 'accepted') return { word: 'Covered', tone: 'ok' };
  if (item.voiceConfirmed) return { word: 'Covered (phone)', tone: 'ok' };
  return { word: 'Covered', tone: 'ok' };
}

function matchesSearch(r: { employeeName?: string; summary?: string }, q: string): boolean {
  if (!q) return true;
  const blob = `${r.employeeName || ''} ${r.summary || ''}`.toLowerCase();
  return blob.includes(q);
}

function matchesCoverageSearch(item: CalloutHistoryEntry, q: string): boolean {
  if (!q) return true;
  const sh = item.shift || {};
  const parts = [
    sh.day,
    sh.role,
    sh.groupLabel,
    ...(item.notified || []),
    item.acceptedBy?.name,
    item.restaurantName,
    calloutContactLabel(item.contactMethod),
  ];
  return parts.join(' ').toLowerCase().includes(q);
}

function requestMatchesType(r: StaffRequestUi, t: ActionTypeFilter): boolean {
  if (t === 'callout') return r.type === 'callout_request' || r.type === 'callout';
  return r.type === t;
}

function requestMatchesStatus(r: StaffRequestUi, s: StatusFilter): boolean {
  if (s === 'pending') return r.status === 'pending';
  if (s === 'closed') return r.status === 'approved' || r.status === 'declined';
  return true;
}

function coverageMatchesStatus(item: CalloutHistoryEntry, s: StatusFilter): boolean {
  if (s === 'pending') return item.status === 'pending';
  if (s === 'closed') return item.status === 'filled' || item.status === 'accepted';
  return true;
}

type Row =
  | { key: string; kind: 'section'; title: string }
  | { key: string; kind: 'bulk' }
  | { key: string; kind: 'staff'; request: StaffRequestUi }
  | { key: string; kind: 'coverage'; item: CalloutHistoryEntry; index: number };

const TYPE_CHIPS: { id: ActionTypeFilter; label: string }[] = [
  { id: 'availability', label: 'Availability' },
  { id: 'timeoff', label: 'Time Off' },
  { id: 'swap', label: 'Shift Swaps' },
  { id: 'callout', label: 'Callouts' },
];

export default function ManagerRequests() {
  const { height: windowHeight } = useWindowDimensions();
  const { staffRequests, teamState, loading, error, refetch } = useAppData();
  const [typeFilter, setTypeFilter] = useState<ActionTypeFilter>('availability');
  const [statusByType, setStatusByType] = useState<Record<ActionTypeFilter, StatusFilter>>({
    availability: 'all',
    timeoff: 'all',
    swap: 'all',
    callout: 'all',
  });
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  /** Same as web: open submitted week in a modal from "View submitted grid". */
  const [gridModal, setGridModal] = useState<StaffRequestUi | null>(null);

  const draftRows = useMemo(() => loadDraftFromTeamState(teamState?.draft_schedule), [teamState]);

  const statusFilter = statusByType[typeFilter];
  const q = search.trim().toLowerCase();

  const calloutHistory = useMemo(() => parseCalloutHistory(teamState?.callout_history), [teamState]);

  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    if (typeFilter === 'callout') {
      const empRows = staffRequests
        .filter((r) => requestMatchesType(r, 'callout'))
        .filter((r) => requestMatchesStatus(r, statusFilter))
        .filter((r) => matchesSearch(r, q))
        .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

      const cov = calloutHistory
        .filter((item) => coverageMatchesStatus(item, statusFilter))
        .filter((item) => matchesCoverageSearch(item, q));

      if (empRows.length) {
        out.push({ key: 'sec-emp', kind: 'section', title: 'Employee call-outs' });
        empRows.forEach((r) => out.push({ key: `s-${r.id}`, kind: 'staff', request: r }));
      }
      if (cov.length) {
        out.push({ key: 'sec-cov', kind: 'section', title: 'Coverage outreach' });
        cov.forEach((item, index) => out.push({ key: `c-${index}`, kind: 'coverage', item, index }));
      }
      return out;
    }

    let list = staffRequests
      .filter((r) => requestMatchesType(r, typeFilter))
      .filter((r) => requestMatchesStatus(r, statusFilter))
      .filter((r) => matchesSearch(r, q))
      .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    if (typeFilter === 'availability') {
      const pendingCount = list.filter((r) => r.status === 'pending').length;
      if (pendingCount > 0) {
        out.push({ key: 'bulk', kind: 'bulk' });
      }
    }

    list.forEach((r) => out.push({ key: `s-${r.id}`, kind: 'staff', request: r }));
    return out;
  }, [staffRequests, typeFilter, statusFilter, q, calloutHistory]);

  const setStatusForType = useCallback((s: StatusFilter) => {
    setStatusByType((prev) => ({ ...prev, [typeFilter]: s }));
  }, [typeFilter]);

  const onApprove = async (id: string) => {
    if (!supabase || !isCloudStaffRequestId(id)) {
      Alert.alert('Cannot update', 'This request is not stored in Supabase yet.');
      return;
    }
    setBusyId(id);
    const res = await updateStaffRequestStatus(supabase, id, 'approved');
    setBusyId(null);
    if (!res.ok) Alert.alert('Update failed', res.message);
    else void refetch();
  };

  const onDecline = async (id: string) => {
    if (!supabase || !isCloudStaffRequestId(id)) {
      Alert.alert('Cannot update', 'This request is not stored in Supabase yet.');
      return;
    }
    setBusyId(id);
    const res = await updateStaffRequestStatus(supabase, id, 'declined');
    setBusyId(null);
    if (!res.ok) Alert.alert('Update failed', res.message);
    else void refetch();
  };

  const onBulkApproveAvailability = async () => {
    if (!supabase) return;
    const targets = staffRequests.filter(
      (r) =>
        r.type === 'availability' &&
        r.status === 'pending' &&
        matchesSearch(r, q)
    );
    const cloud = targets.filter((r) => isCloudStaffRequestId(r.id));
    if (!cloud.length) {
      Alert.alert('Nothing to accept', 'No pending availability rows from Supabase match the current search.');
      return;
    }
    setBusyId('bulk');
    for (const r of cloud) {
      await updateStaffRequestStatus(supabase, r.id, 'approved');
    }
    setBusyId(null);
    void refetch();
  };

  const typeLabel = (r: StaffRequestUi) => {
    if (r.type === 'availability') return 'Availability';
    if (r.type === 'swap') return 'Shift Swap';
    if (r.type === 'timeoff') return 'Time Off';
    if (r.type === 'callout_request' || r.type === 'callout') return 'Employee call-out';
    return r.type;
  };

  const renderRow = ({ item }: { item: Row }) => {
    if (item.kind === 'section') {
      return (
        <View style={styles.sectionHead}>
          <Text style={styles.sectionHeadText}>{item.title}</Text>
        </View>
      );
    }
    if (item.kind === 'bulk') {
      return (
        <View style={styles.row}>
          <Pressable
            style={[styles.btnPrimary, busyId === 'bulk' && styles.btnDisabled]}
            disabled={busyId === 'bulk'}
            onPress={() => void onBulkApproveAvailability()}
          >
            <Text style={styles.btnPrimaryText}>
              {busyId === 'bulk' ? 'Working…' : 'Accept all pending (matches search)'}
            </Text>
          </Pressable>
        </View>
      );
    }
    if (item.kind === 'coverage') {
      const { item: c } = item;
      const sh = c.shift || {};
      const roleLabel = sh.groupLabel || sh.role || '';
      const pres = coverageStatusLine(c);
      const reached = (c.notified || []).filter(Boolean);
      const covStatusStyle =
        pres.tone === 'pending' ? styles.status_pending : pres.tone === 'muted' ? styles.status_muted : styles.status_ok;
      return (
        <View style={styles.row}>
          <View style={styles.rowHeader}>
            <Text style={styles.rolePill}>{roleLabel}</Text>
            <Text style={[styles.statusPill, covStatusStyle]}>{pres.word}</Text>
          </View>
          <Text style={styles.meta}>
            {sh.day} · {sh.timeLabel || (sh.start && sh.end ? `${sh.start} – ${sh.end}` : '')}
          </Text>
          {c.restaurantName ? <Text style={styles.meta}>Location: {c.restaurantName}</Text> : null}
          <Text style={styles.meta}>Outreach: {calloutContactLabel(c.contactMethod)}</Text>
          {c.originalWorkers?.length ? (
            <Text style={styles.meta}>Originally scheduled: {c.originalWorkers.filter(Boolean).join(', ')}</Text>
          ) : null}
          <Text style={styles.notes}>
            Reached out to: {reached.length ? reached.join(', ') : '—'}
          </Text>
          {c.acceptedBy?.name ? (
            <Text style={styles.highlight}>Took the shift: {c.acceptedBy.name}</Text>
          ) : (
            <Text style={styles.mutedLine}>Took the shift: No one yet</Text>
          )}
        </View>
      );
    }

    const r = item.request;
    const roleLabel = staffTypeLabel(r.role);
    const statusWord =
      r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Pending';
    const staffStatusStyle =
      r.status === 'approved' ? styles.status_ok : r.status === 'declined' ? styles.status_bad : styles.status_pending;

    return (
      <View style={styles.row}>
        <View style={styles.rowHeader}>
          <Text style={styles.empName}>{r.employeeName}</Text>
          <Text style={[styles.statusPill, staffStatusStyle]}>{statusWord}</Text>
        </View>
        <Text style={styles.meta}>
          {roleLabel} · {typeLabel(r)} · Submitted {formatStaffRequestSubmittedDate(r.submittedAt)}
        </Text>
        <Text style={styles.notes}>{r.summary}</Text>
        {r.type === 'availability' &&
        r.submittedGrid &&
        submittedAvailabilityGridIsNonEmpty(r.submittedGrid) ? (
          <View style={styles.viewGridWrap}>
            <Pressable style={styles.btnSecondary} onPress={() => setGridModal(r)}>
              <Text style={styles.btnSecondaryText}>View submitted grid</Text>
            </Pressable>
          </View>
        ) : null}
        {r.status === 'pending' ? (
          <View style={styles.actions}>
            <Pressable
              style={[styles.btnPrimary, busyId === r.id && styles.btnDisabled]}
              disabled={busyId === r.id}
              onPress={() => void onApprove(r.id)}
            >
              <Text style={styles.btnPrimaryText}>Approve</Text>
            </Pressable>
            <Pressable
              style={[styles.btnGhost, busyId === r.id && styles.btnDisabled]}
              disabled={busyId === r.id}
              onPress={() => void onDecline(r.id)}
            >
              <Text style={styles.btnGhostText}>Decline</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const empty =
    typeFilter === 'callout'
      ? 'No employee call-outs or coverage campaigns match this filter.'
      : 'No actions match this type, status, or search.';

  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.typeChipsScroll}
        contentContainerStyle={styles.typeChipsScrollContent}
      >
        {/* Inner row so RN Web does not stretch chips across the full viewport width. */}
        <View style={styles.typeChipsInner}>
          {TYPE_CHIPS.map((c) => (
            <Pressable
              key={c.id}
              onPress={() => setTypeFilter(c.id)}
              style={[styles.filterChip, typeFilter === c.id && styles.chipActive]}
            >
              <Text
                style={[styles.filterChipText, typeFilter === c.id && styles.chipTextActive]}
                numberOfLines={1}
                ellipsizeMode="tail"
              >
                {c.label}
              </Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
      <View style={styles.statusRow}>
        <View style={styles.statusChipsInner}>
          {(['all', 'pending', 'closed'] as const).map((s) => (
            <Pressable
              key={s}
              onPress={() => setStatusForType(s)}
              style={[styles.filterChip, statusFilter === s && styles.chipActive]}
            >
              <Text style={[styles.filterChipText, statusFilter === s && styles.chipTextActive]}>
                {s === 'all' ? 'All' : s === 'pending' ? 'Pending' : 'Closed'}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search employee name"
        placeholderTextColor="#888"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {loading && !staffRequests.length ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item) => item.key}
          refreshing={loading}
          onRefresh={() => void refetch()}
          renderItem={renderRow}
          ListEmptyComponent={<Text style={styles.muted}>{empty}</Text>}
          contentContainerStyle={styles.listPad}
        />
      )}

      <Modal visible={!!gridModal} animationType="slide" transparent onRequestClose={() => setGridModal(null)}>
        <Pressable style={styles.modalBackdrop} onPress={() => setGridModal(null)}>
          <Pressable style={styles.modalPanel} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>
              {gridModal ? `Availability — ${gridModal.employeeName}` : ''}
            </Text>
            {gridModal ? (
              <Text style={styles.modalMeta}>
                {staffTypeLabel(gridModal.role)} · Submitted {formatStaffRequestSubmittedDate(gridModal.submittedAt)}
              </Text>
            ) : null}
            <ScrollView
              style={[styles.modalScroll, { maxHeight: Math.round(windowHeight * 0.72) }]}
              nestedScrollEnabled
              showsVerticalScrollIndicator
              keyboardShouldPersistTaps="handled"
            >
              {gridModal && gridModal.submittedGrid && submittedAvailabilityGridIsNonEmpty(gridModal.submittedGrid) ? (
                <AvailabilityMatrixReadOnly
                  weeklyGrid={gridModal.submittedGrid as Record<string, unknown>}
                  staffType={gridModal.role}
                  draftRows={draftRows}
                  embedInParentScroll
                />
              ) : null}
            </ScrollView>
            <Pressable style={styles.modalClose} onPress={() => setGridModal(null)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  err: { color: '#b00020', padding: 12 },
  typeChipsScroll: { flexGrow: 0 },
  /** Do not use flexGrow: 1 here — it spreads chip row edge-to-edge on web. */
  typeChipsScrollContent: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    flexGrow: 0,
    alignItems: 'center',
  },
  typeChipsInner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 4,
  },
  /** Same vertical size as status chips (All / Pending / Closed). */
  filterChip: {
    paddingHorizontal: 8,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    backgroundColor: '#fff',
  },
  chipActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  filterChipText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  chipTextActive: { color: '#c41230' },
  statusRow: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    alignItems: 'flex-start',
  },
  statusChipsInner: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'nowrap',
    gap: 4,
  },
  search: {
    marginHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  listPad: { paddingBottom: 32 },
  sectionHead: { paddingHorizontal: 16, paddingVertical: 10, backgroundColor: '#e8ecf1' },
  sectionHeadText: { fontSize: 13, fontWeight: '700', color: '#475569' },
  row: {
    backgroundColor: '#fff',
    padding: 14,
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaed',
  },
  rowHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  empName: { fontSize: 16, fontWeight: '700', color: '#111', flex: 1 },
  rolePill: { fontSize: 13, fontWeight: '600', color: '#0f172a', flex: 1 },
  statusPill: { fontSize: 12, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6 },
  status_pending: { backgroundColor: '#fef3c7', color: '#92400e' },
  status_ok: { backgroundColor: '#d1fae5', color: '#047857' },
  status_bad: { backgroundColor: '#fee2e2', color: '#b91c1c' },
  status_muted: { backgroundColor: '#f1f5f9', color: '#64748b' },
  meta: { fontSize: 13, color: '#64748b', marginTop: 6 },
  notes: { fontSize: 15, color: '#222', marginTop: 10, lineHeight: 22 },
  mutedLine: { fontSize: 14, color: '#94a3b8', marginTop: 6 },
  highlight: { fontSize: 14, fontWeight: '600', color: '#047857', marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  btnPrimary: { backgroundColor: '#c41230', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  viewGridWrap: { marginTop: 10 },
  btnSecondary: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#fff',
  },
  btnSecondaryText: { color: '#334155', fontWeight: '600', fontSize: 15, textAlign: 'center' },
  btnGhost: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  btnGhostText: { color: '#334155', fontWeight: '700' },
  btnDisabled: { opacity: 0.5 },
  muted: { fontSize: 14, color: '#888', padding: 20 },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'center',
    padding: 16,
  },
  modalPanel: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    maxHeight: '88%',
  },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  modalMeta: { fontSize: 14, color: '#64748b', marginTop: 8, lineHeight: 20 },
  modalScroll: { marginTop: 12 },
  modalClose: { marginTop: 14, paddingVertical: 12, alignItems: 'center' },
  modalCloseText: { fontSize: 16, color: '#c41230', fontWeight: '700' },
});
