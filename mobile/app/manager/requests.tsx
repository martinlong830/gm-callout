import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { approveStaffRequest } from '../../lib/approveStaffRequest';
import {
  employeeDisplayName,
  employeeVisibleInManagerStoreScope,
  managerManagedRestaurantId,
} from '../../lib/employees';
import { DEFAULT_DRAFT_SCHEDULE_ROWS } from '../../lib/schedule/engine';
import type { AssignmentStore } from '../../lib/schedule/types';
import {
  formatStaffRequestSubmittedDate,
  isCloudStaffRequestId,
  type StaffRequestUi,
  updateStaffRequestStatus,
} from '../../lib/staffRequests';
import {
  swapRequestCanManagerApprove,
  swapRequestDisplayStatus,
} from '../../lib/shiftSwap';
import { supabase } from '../../lib/supabase';

type ActionTypeFilter = 'timeoff' | 'swap' | 'callout';
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
    restaurantId?: string;
  };
  status?: string;
  acceptedBy?: { name?: string; role?: string } | null;
  notified?: string[];
  noResponse?: string[];
  contactMethod?: string | null;
  originalWorkers?: string[];
  restaurantName?: string | null;
  restaurantId?: string | null;
  voiceConfirmed?: boolean;
};

function parseCalloutHistory(raw: unknown): CalloutHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is CalloutHistoryEntry =>
      !!e && typeof e === 'object' && !!(e as CalloutHistoryEntry).shift && typeof (e as CalloutHistoryEntry).shift === 'object'
  );
}

function calloutContactLabel(method: string | null | undefined, t: (k: string) => string): string {
  if (method === 'call') return t('requests.phoneCall');
  if (method === 'text') return t('requests.textMsg');
  return method ? String(method) : '—';
}

function coverageStatusLine(
  item: CalloutHistoryEntry,
  t: (k: string) => string
): { word: string; tone: 'pending' | 'ok' | 'muted' } {
  if (item.status === 'pending') return { word: t('requests.awaitingResponse'), tone: 'pending' };
  if (item.status === 'accepted') return { word: t('requests.covered'), tone: 'ok' };
  if (item.voiceConfirmed) return { word: t('requests.coveredPhone'), tone: 'ok' };
  return { word: t('requests.covered'), tone: 'ok' };
}

function matchesSearch(r: { employeeName?: string; summary?: string }, q: string): boolean {
  if (!q) return true;
  const blob = `${r.employeeName || ''} ${r.summary || ''}`.toLowerCase();
  return blob.includes(q);
}

function matchesCoverageSearch(item: CalloutHistoryEntry, q: string, contactLabel: string): boolean {
  if (!q) return true;
  const sh = item.shift || {};
  const parts = [
    sh.day,
    sh.role,
    sh.groupLabel,
    ...(item.notified || []),
    item.acceptedBy?.name,
    item.restaurantName,
    contactLabel,
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
  | { key: string; kind: 'staff'; request: StaffRequestUi }
  | { key: string; kind: 'coverage'; item: CalloutHistoryEntry; index: number };

const TYPE_CHIPS: { id: ActionTypeFilter; labelKey: string }[] = [
  { id: 'timeoff', labelKey: 'actions.timeOff' },
  { id: 'swap', labelKey: 'actions.shiftSwaps' },
  { id: 'callout', labelKey: 'actions.callouts' },
];

export default function ManagerRequests() {
  const { staffRequests, teamState, loading, error, refetch, employees, myEmployee, applyLocalScheduleAssignments } =
    useAppData();
  const { role } = useAuth();
  const { t, staffTypeLabel, statusLabel } = useI18n();
  const params = useLocalSearchParams<{ subsection?: string; requestId?: string }>();
  const [typeFilter, setTypeFilter] = useState<ActionTypeFilter>('timeoff');
  const [statusByType, setStatusByType] = useState<Record<ActionTypeFilter, StatusFilter>>({
    timeoff: 'all',
    swap: 'all',
    callout: 'all',
  });
  const [search, setSearch] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const listRef = useRef<FlatList<Row> | null>(null);
  const focusRequestId = String(params.requestId || '').trim();

  useEffect(() => {
    const raw = String(params.subsection || '')
      .trim()
      .toLowerCase();
    if (raw === 'timeoff' || raw === 'swap' || raw === 'callout') {
      setTypeFilter(raw);
    }
  }, [params.subsection]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch().finally(() => setRefreshing(false));
  }, [refetch]);

  const statusFilter = statusByType[typeFilter];
  const q = search.trim().toLowerCase();

  const storeScope = useMemo(() => managerManagedRestaurantId(myEmployee, role), [myEmployee, role]);

  const assignmentStore = useMemo(
    () => (teamState?.schedule_assignments || {}) as AssignmentStore,
    [teamState?.schedule_assignments]
  );
  const scopedNameSet = useMemo(() => {
    if (!storeScope) return null;
    const set = new Set<string>();
    for (const e of employees) {
      if (!employeeVisibleInManagerStoreScope(e, storeScope)) continue;
      set.add(employeeDisplayName(e).trim().toLowerCase());
    }
    return set;
  }, [employees, storeScope]);

  const requestInScope = useCallback(
    (r: StaffRequestUi) => {
      if (!scopedNameSet) return true;
      const name = String(r.employeeName || '')
        .trim()
        .toLowerCase();
      return !!name && scopedNameSet.has(name);
    },
    [scopedNameSet]
  );

  const calloutHistory = useMemo(() => parseCalloutHistory(teamState?.callout_history), [teamState]);

  const rows = useMemo((): Row[] => {
    const out: Row[] = [];
    if (typeFilter === 'callout') {
      const empRows = staffRequests
        .filter((r) => requestMatchesType(r, 'callout'))
        .filter((r) => requestInScope(r))
        .filter((r) => requestMatchesStatus(r, statusFilter))
        .filter((r) => matchesSearch(r, q))
        .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

      const cov = calloutHistory
        .filter((item) => coverageMatchesStatus(item, statusFilter))
        .filter((item) => {
          if (!storeScope) return true;
          const rid = String(item.shift?.restaurantId || item.restaurantId || '');
          if (rid === 'rp-8' || rid === 'rp-9') return rid === storeScope;
          const name = String(item.restaurantName || '').toLowerCase();
          if (!name) return true;
          if (storeScope === 'rp-8') return name.includes('8th');
          if (storeScope === 'rp-9') return name.includes('9th');
          return true;
        })
        .filter((item) => matchesCoverageSearch(item, q, calloutContactLabel(item.contactMethod, t)));

      if (empRows.length) {
        out.push({ key: 'sec-emp', kind: 'section', title: t('requests.employeeCallouts') });
        empRows.forEach((r) => out.push({ key: `s-${r.id}`, kind: 'staff', request: r }));
      }
      if (cov.length) {
        out.push({ key: 'sec-cov', kind: 'section', title: t('requests.coverageOutreach') });
        cov.forEach((item, index) => out.push({ key: `c-${index}`, kind: 'coverage', item, index }));
      }
      return out;
    }

    const list = staffRequests
      .filter((r) => r.type !== 'availability')
      .filter((r) => requestMatchesType(r, typeFilter))
      .filter((r) => requestInScope(r))
      .filter((r) => requestMatchesStatus(r, statusFilter))
      .filter((r) => matchesSearch(r, q))
      .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));

    list.forEach((r) => out.push({ key: `s-${r.id}`, kind: 'staff', request: r }));
    return out;
  }, [staffRequests, typeFilter, statusFilter, q, calloutHistory, t, requestInScope, storeScope]);

  useEffect(() => {
    if (!focusRequestId || !rows.length) return;
    const idx = rows.findIndex(
      (r) => r.kind === 'staff' && r.request.id === focusRequestId
    );
    if (idx < 0) return;
    const timer = setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.15 });
      } catch {
        /* ignore measure failures before layout */
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [focusRequestId, rows]);

  const setStatusForType = useCallback((s: StatusFilter) => {
    setStatusByType((prev) => ({ ...prev, [typeFilter]: s }));
  }, [typeFilter]);

  const onApprove = async (req: StaffRequestUi) => {
    if (!supabase || !isCloudStaffRequestId(req.id)) {
      Alert.alert(t('requests.cannotUpdate'), t('requests.notInSupabase'));
      return;
    }
    if (req.type === 'swap' && !swapRequestCanManagerApprove(req)) {
      Alert.alert(t('requests.cannotUpdate'), t('requests.swapNeedsCover'));
      return;
    }
    setBusyId(req.id);
    const res = await approveStaffRequest(supabase, req, employees, DEFAULT_DRAFT_SCHEDULE_ROWS, {
      allRequests: staffRequests,
      assignmentStore,
      draftScheduleRaw: teamState?.draft_schedule,
    });
    setBusyId(null);
    if (!res.ok) Alert.alert(t('requests.updateFailed'), res.message);
    else {
      if (res.store) applyLocalScheduleAssignments(res.store);
      void refetch({ silent: true });
    }
  };

  const onDecline = async (id: string) => {
    if (!supabase || !isCloudStaffRequestId(id)) {
      Alert.alert(t('requests.cannotUpdate'), t('requests.notInSupabase'));
      return;
    }
    setBusyId(id);
    const req = staffRequests.find((r) => r.id === id);
    const res = await updateStaffRequestStatus(supabase, id, 'declined');
    if (res.ok && req?.type === 'swap' && !req.swapOfferId) {
      const linked = staffRequests.filter(
        (r) =>
          r.type === 'swap' &&
          r.status === 'pending' &&
          r.swapOfferId === id &&
          isCloudStaffRequestId(r.id)
      );
      for (const c of linked) {
        await updateStaffRequestStatus(supabase, c.id, 'declined');
      }
    }
    setBusyId(null);
    if (!res.ok) Alert.alert(t('requests.updateFailed'), res.message);
    else void refetch({ silent: true });
  };

  const typeLabel = (r: StaffRequestUi) => {
    if (r.type === 'swap') return t('requests.shiftSwap');
    if (r.type === 'timeoff') return t('actions.timeOff');
    if (r.type === 'callout_request' || r.type === 'callout') return t('requests.employeeCallout');
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
    if (item.kind === 'coverage') {
      const { item: c } = item;
      const sh = c.shift || {};
      const roleLabel = sh.groupLabel || sh.role || '';
      const pres = coverageStatusLine(c, t);
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
          {c.restaurantName ? (
            <Text style={styles.meta}>{t('requests.locationLabel')}: {c.restaurantName}</Text>
          ) : null}
          <Text style={styles.meta}>{t('requests.outreach')}: {calloutContactLabel(c.contactMethod, t)}</Text>
          {c.originalWorkers?.length ? (
            <Text style={styles.meta}>
              {t('requests.originallyScheduled')}: {c.originalWorkers.filter(Boolean).join(', ')}
            </Text>
          ) : null}
          <Text style={styles.notes}>
            {t('requests.reachedOut')}: {reached.length ? reached.join(', ') : '—'}
          </Text>
          {c.acceptedBy?.name ? (
            <Text style={styles.highlight}>{t('requests.tookShift')}: {c.acceptedBy.name}</Text>
          ) : (
            <Text style={styles.mutedLine}>{t('requests.tookShift')}: {t('requests.noOneYet')}</Text>
          )}
        </View>
      );
    }

    const r = item.request;
    const roleLabel = staffTypeLabel(r.role);
    const displayStatus = swapRequestDisplayStatus(r, staffRequests);
    const statusWord = statusLabel(displayStatus);
    const staffStatusStyle =
      r.status === 'approved'
        ? styles.status_ok
        : r.status === 'declined'
          ? styles.status_bad
          : styles.status_pending;
    const canApprove =
      r.status === 'pending' && (r.type !== 'swap' || swapRequestCanManagerApprove(r));

    return (
      <View style={[styles.row, focusRequestId && r.id === focusRequestId ? styles.rowFocused : null]}>
        <View style={styles.rowHeader}>
          <Text style={styles.empName}>{r.employeeName}</Text>
          <Text style={[styles.statusPill, staffStatusStyle]}>{statusWord}</Text>
        </View>
        <Text style={styles.meta}>
          {roleLabel} · {typeLabel(r)} · {t('requests.submitted')}{' '}
          {formatStaffRequestSubmittedDate(r.submittedAt)}
        </Text>
        {r.type === 'swap' && r.offeredShiftLabel ? (
          <Text style={styles.highlight}>{t('requests.offeredShift')}: {r.offeredShiftLabel}</Text>
        ) : null}
        {r.type === 'swap' && !r.swapOfferId && r.swapTargetEmployeeName ? (
          <Text style={styles.meta}>
            {t('requests.swapTarget')}: {r.swapTargetEmployeeName}
          </Text>
        ) : null}
        {r.type === 'swap' && !r.swapOfferId && !r.swapTargetEmployeeId ? (
          <Text style={styles.meta}>{t('requests.swapTargetEveryone')}</Text>
        ) : null}
        {r.type === 'swap' && r.swapOfferId ? (
          <Text style={styles.meta}>
            {(() => {
              const offer = staffRequests.find((o) => o.id === r.swapOfferId);
              return offer?.offeredShiftLabel
                ? `${t('requests.acceptingOffer')}: ${offer.offeredShiftLabel}`
                : `${t('requests.acceptingOffer')} #${r.swapOfferId.slice(0, 8)}…`;
            })()}
          </Text>
        ) : null}
        {r.type === 'swap' && displayStatus === 'awaiting_cover' ? (
          <Text style={styles.mutedLine}>{t('requests.swapAwaitingCover')}</Text>
        ) : null}
        <Text style={styles.notes}>{r.summary}</Text>
        {r.status === 'pending' ? (
          <View style={styles.actions}>
            {canApprove ? (
              <Pressable
                style={[styles.btnPrimary, busyId === r.id && styles.btnDisabled]}
                disabled={busyId === r.id}
                onPress={() => void onApprove(r)}
              >
                <Text style={styles.btnPrimaryText}>{t('common.approve')}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.btnGhost, busyId === r.id && styles.btnDisabled]}
              disabled={busyId === r.id}
              onPress={() => void onDecline(r.id)}
            >
              <Text style={styles.btnGhostText}>{t('common.decline')}</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const empty =
    typeFilter === 'callout' ? t('requests.emptyCallout') : t('requests.emptyFilter');

  return (
    <View style={styles.screen}>
      {error ? <Text style={styles.err}>{error}</Text> : null}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.typeChipsScroll}
        contentContainerStyle={styles.typeChipsScrollContent}
      >
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
                {t(c.labelKey)}
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
                {s === 'all' ? t('common.all') : s === 'pending' ? t('status.pending') : t('common.closed')}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder={t('requests.searchEmployee')}
        placeholderTextColor="#888"
        autoCapitalize="none"
        autoCorrect={false}
      />
      {loading && !staffRequests.length ? (
        <ActivityIndicator style={{ marginTop: 24 }} />
      ) : (
        <FlatList
          ref={listRef}
          style={styles.list}
          data={rows}
          keyExtractor={(item) => item.key}
          refreshing={refreshing}
          onRefresh={onRefresh}
          renderItem={renderRow}
          onScrollToIndexFailed={(info) => {
            setTimeout(() => {
              try {
                listRef.current?.scrollToIndex({
                  index: info.index,
                  animated: true,
                  viewPosition: 0.15,
                });
              } catch {
                /* ignore */
              }
            }, 300);
          }}
          ListEmptyComponent={<Text style={styles.muted}>{empty}</Text>}
          contentContainerStyle={styles.listPad}
          keyboardShouldPersistTaps="handled"
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  err: { color: '#b00020', padding: 12 },
  typeChipsScroll: { flexGrow: 0 },
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
  list: { flex: 1 },
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
  rowFocused: {
    backgroundColor: '#fff7ed',
    borderLeftWidth: 3,
    borderLeftColor: '#c41230',
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
});
