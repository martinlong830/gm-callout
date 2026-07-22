import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { AvailabilityMatrixEditor, availabilityCheckAll } from './AvailabilityMatrixEditor';
import { ScheduleWeekPicker } from './ScheduleWeekPicker';
import { useAppData } from '../contexts/AppDataContext';
import {
  applyAvailabilityWeekEntry,
  availabilityStatusLabel,
  getEmployeeAvailabilityWeekEntry,
  listPendingAvailabilityEmployees,
  type AvailabilityWeekStatus,
} from '../lib/availabilityByWeek';
import { saveEmployeeRow } from '../lib/employeeSave';
import { employeeDisplayName, staffTypeLabel, type EmployeeRow } from '../lib/employees';
import {
  buildWeeksFromMonday,
  getScheduleAnchorMondayDate,
  loadDraftFromTeamState,
  localTodayISO,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
} from '../lib/schedule/engine';
import { compareEmployeesByScheduleOrder } from '../lib/schedule/rosterOrder';
import { supabase } from '../lib/supabase';
import { updateStaffRequestStatus } from '../lib/staffRequests';
import type { WeeklyGridNormalized } from '../lib/weeklyAvailabilityMatrix';

type Mode = 'manager' | 'employee';

type Props = {
  mode: Mode;
  /** Employee mode: the signed-in roster row. */
  selfEmployee?: EmployeeRow | null;
};

function StatusBadge({ status }: { status: AvailabilityWeekStatus }) {
  const label = availabilityStatusLabel(status);
  const tone =
    status === 'approved'
      ? styles.badgeApproved
      : status === 'declined'
        ? styles.badgeDeclined
        : status === 'submitted'
          ? styles.badgeSubmitted
          : styles.badgeDraft;
  const textTone =
    status === 'approved'
      ? styles.badgeTextApproved
      : status === 'declined'
        ? styles.badgeTextDeclined
        : status === 'submitted'
          ? styles.badgeTextSubmitted
          : styles.badgeTextDraft;
  return (
    <View style={[styles.badge, tone]}>
      <Text style={[styles.badgeText, textTone]}>{label}</Text>
    </View>
  );
}

export function AvailabilityScreen({ mode, selfEmployee }: Props) {
  const { employees, staffRequests, teamState, refetch, loading } = useAppData();
  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );

  const roster = useMemo(
    () => [...employees].sort(compareEmployeesByScheduleOrder),
    [employees]
  );

  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const [selectedEmployeeId, setSelectedEmployeeId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [grid, setGrid] = useState<WeeklyGridNormalized | null>(null);
  const [status, setStatus] = useState<AvailabilityWeekStatus>('draft');
  const [submittedAt, setSubmittedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const skipNextHydrate = useRef(false);

  const draftRows = useMemo(
    () => loadDraftFromTeamState(teamState?.draft_schedule, weekIndex),
    [teamState, weekIndex]
  );

  const activeEmployee: EmployeeRow | null = useMemo(() => {
    if (mode === 'employee') return selfEmployee ?? null;
    if (!roster.length) return null;
    const id = selectedEmployeeId || roster[0]?.id;
    return roster.find((e) => e.id === id) ?? roster[0] ?? null;
  }, [mode, selfEmployee, roster, selectedEmployeeId]);

  const pendingEmployees = useMemo(() => {
    if (mode !== 'manager') return [];
    return listPendingAvailabilityEmployees(roster, weekIndex, draftRows, staffRequests);
  }, [mode, roster, weekIndex, draftRows, staffRequests]);

  useEffect(() => {
    if (mode !== 'manager' || !roster.length) return;
    if (selectedEmployeeId && roster.some((e) => e.id === selectedEmployeeId)) return;
    setSelectedEmployeeId(roster[0].id);
  }, [mode, roster, selectedEmployeeId]);

  const hydrateFromEmployee = useCallback(
    (emp: EmployeeRow, wi: number) => {
      const entry = getEmployeeAvailabilityWeekEntry(emp, wi, draftRows, staffRequests);
      setGrid(entry.grid);
      setStatus(entry.status);
      setSubmittedAt(entry.submittedAt);
    },
    [draftRows, staffRequests]
  );

  useEffect(() => {
    if (!activeEmployee) {
      setGrid(null);
      setStatus('draft');
      setSubmittedAt(null);
      return;
    }
    if (skipNextHydrate.current) {
      skipNextHydrate.current = false;
      return;
    }
    hydrateFromEmployee(activeEmployee, weekIndex);
  }, [activeEmployee, weekIndex, hydrateFromEmployee]);

  const persistWeekOverlay = useCallback(
    async (
      emp: EmployeeRow,
      wi: number,
      nextGrid: WeeklyGridNormalized,
      opts: {
        syncWeeklyGrid: boolean;
        /** Employee edits always become draft; manager week-switch preserves badge. */
        forceDraft?: boolean;
        preserveStatus?: AvailabilityWeekStatus;
        preserveSubmittedAt?: string | null;
        forceStatus?: AvailabilityWeekStatus;
      }
    ) => {
      if (!supabase) return { ok: false as const, message: 'Not configured' };
      const nextStatus: AvailabilityWeekStatus = opts.forceDraft
        ? 'draft'
        : opts.forceStatus
          ? opts.forceStatus
          : opts.preserveStatus && opts.preserveStatus !== 'draft'
            ? opts.preserveStatus
            : 'draft';
      const keepSubmittedAt =
        nextStatus === 'submitted' ||
        nextStatus === 'approved' ||
        nextStatus === 'declined';
      const updated = applyAvailabilityWeekEntry(
        emp,
        wi,
        {
          grid: nextGrid,
          status: nextStatus,
          submittedAt: keepSubmittedAt
            ? opts.preserveSubmittedAt || localTodayISO()
            : null,
        },
        { syncWeeklyGrid: opts.syncWeeklyGrid, draftRows }
      );
      const res = await saveEmployeeRow(supabase, updated);
      if (!res.ok) return res;
      skipNextHydrate.current = true;
      void refetch({ silent: true });
      return { ok: true as const, employee: updated };
    },
    [draftRows, refetch]
  );

  const syncMatchingAvailabilityStaffRequest = useCallback(
    async (emp: EmployeeRow, wi: number, nextStatus: 'approved' | 'declined') => {
      if (!supabase) return;
      const nameKey = employeeDisplayName(emp).trim().toLowerCase();
      if (!nameKey) return;
      for (const r of staffRequests) {
        if (!r || r.type !== 'availability' || r.status !== 'pending') continue;
        if (r.submittedWeekIndex != null && Number(r.submittedWeekIndex) !== Number(wi)) {
          continue;
        }
        const rn = String(r.employeeName || '')
          .trim()
          .toLowerCase();
        if (rn !== nameKey) continue;
        await updateStaffRequestStatus(supabase, r.id, nextStatus);
      }
    },
    [staffRequests]
  );

  const onGridChange = useCallback(
    (next: WeeklyGridNormalized) => {
      setGrid(next);
      if (mode === 'employee') {
        setStatus('draft');
        setSubmittedAt(null);
        if (!activeEmployee) return;
        void (async () => {
          const res = await persistWeekOverlay(activeEmployee, weekIndex, next, {
            syncWeeklyGrid: false,
            forceDraft: true,
          });
          if (!res.ok) Alert.alert('Availability', res.message);
          else setFeedback('Draft saved');
        })();
      }
    },
    [mode, activeEmployee, weekIndex, persistWeekOverlay]
  );

  const changeWeek = useCallback(
    async (nextWi: number) => {
      if (nextWi === weekIndex) return;
      if (activeEmployee && grid) {
        const res = await persistWeekOverlay(activeEmployee, weekIndex, grid, {
          syncWeeklyGrid: false,
          forceDraft: mode === 'employee',
          preserveStatus: status,
          preserveSubmittedAt: submittedAt,
        });
        if (!res.ok) {
          Alert.alert('Availability', res.message);
          return;
        }
      }
      setWeekIndex(nextWi);
      setFeedback('');
    },
    [weekIndex, activeEmployee, grid, mode, status, submittedAt, persistWeekOverlay]
  );

  const changeEmployee = useCallback(
    async (emp: EmployeeRow) => {
      setPickerOpen(false);
      if (emp.id === activeEmployee?.id) return;
      if (activeEmployee && grid) {
        const res = await persistWeekOverlay(activeEmployee, weekIndex, grid, {
          syncWeeklyGrid: false,
          preserveStatus: status,
          preserveSubmittedAt: submittedAt,
        });
        if (!res.ok) {
          Alert.alert('Availability', res.message);
          return;
        }
      }
      setSelectedEmployeeId(emp.id);
      setFeedback('');
    },
    [activeEmployee, grid, weekIndex, status, submittedAt, persistWeekOverlay]
  );

  const onCheckAll = useCallback(() => {
    if (!activeEmployee || !grid) return;
    const next = availabilityCheckAll(activeEmployee.staffType || 'Kitchen', draftRows, grid);
    onGridChange(next);
  }, [activeEmployee, grid, draftRows, onGridChange]);

  const onManagerSave = useCallback(async () => {
    if (!activeEmployee || !grid) return;
    setBusy(true);
    setFeedback('');
    try {
      const res = await persistWeekOverlay(activeEmployee, weekIndex, grid, {
        syncWeeklyGrid: true,
        preserveStatus: status,
        preserveSubmittedAt: submittedAt,
      });
      if (!res.ok) {
        Alert.alert('Availability', res.message);
        return;
      }
      setFeedback(`Saved availability for ${employeeDisplayName(activeEmployee)}.`);
    } finally {
      setBusy(false);
    }
  }, [activeEmployee, grid, weekIndex, status, submittedAt, persistWeekOverlay]);

  const onManagerReview = useCallback(
    async (action: 'approve' | 'decline') => {
      if (!activeEmployee || !grid || status !== 'submitted') return;
      setBusy(true);
      setFeedback('');
      try {
        const nextStatus: AvailabilityWeekStatus =
          action === 'approve' ? 'approved' : 'declined';
        const res = await persistWeekOverlay(activeEmployee, weekIndex, grid, {
          syncWeeklyGrid: nextStatus === 'approved',
          forceStatus: nextStatus,
          preserveSubmittedAt: submittedAt,
        });
        if (!res.ok) {
          Alert.alert('Availability', res.message);
          return;
        }
        await syncMatchingAvailabilityStaffRequest(activeEmployee, weekIndex, nextStatus);
        setStatus(nextStatus);
        setFeedback(
          `${nextStatus === 'approved' ? 'Approved' : 'Declined'} availability for ${employeeDisplayName(activeEmployee)}.`
        );
        void refetch({ silent: true });
      } finally {
        setBusy(false);
      }
    },
    [
      activeEmployee,
      grid,
      status,
      weekIndex,
      submittedAt,
      persistWeekOverlay,
      syncMatchingAvailabilityStaffRequest,
      refetch,
    ]
  );

  const onEmployeeSubmit = useCallback(async () => {
    if (!supabase || !activeEmployee || !grid) return;
    setBusy(true);
    setFeedback('');
    try {
      const today = localTodayISO();
      const updated = applyAvailabilityWeekEntry(
        activeEmployee,
        weekIndex,
        { grid, status: 'submitted', submittedAt: today },
        { syncWeeklyGrid: true, draftRows }
      );
      const saveRes = await saveEmployeeRow(supabase, updated);
      if (!saveRes.ok) {
        Alert.alert('Availability', saveRes.message);
        return;
      }
      skipNextHydrate.current = true;
      setStatus('submitted');
      setSubmittedAt(today);
      setFeedback('Submitted. Waiting for your manager to approve.');
      void refetch({ silent: true });
    } finally {
      setBusy(false);
    }
  }, [activeEmployee, grid, weekIndex, draftRows, refetch]);

  if (loading && !employees.length) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator color="#c41230" />
      </View>
    );
  }

  if (!activeEmployee) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>
          {mode === 'employee' ? 'Your roster profile is not linked yet.' : 'No team members found.'}
        </Text>
      </View>
    );
  }

  const staffType = activeEmployee.staffType || 'Kitchen';
  const showReviewActions = mode === 'manager' && status === 'submitted';

  return (
    <View style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {mode === 'manager' ? (
          <View style={styles.pickerBlock}>
            <Text style={styles.fieldLabel}>Employee</Text>
            <Pressable style={styles.employeeSelect} onPress={() => setPickerOpen(true)}>
              <Text style={styles.employeeSelectText} numberOfLines={1}>
                {employeeDisplayName(activeEmployee)}
              </Text>
              <Text style={styles.employeeSelectChevron}>▾</Text>
            </Pressable>
            <Text style={styles.roleLine}>{staffTypeLabel(staffType)}</Text>
          </View>
        ) : (
          <Text style={styles.hint}>
            Edit your availability by week. Changes save as a draft until you submit.
          </Text>
        )}

        <ScheduleWeekPicker
          mode="managerNav"
          weekMeta={weekMeta}
          weekIndex={weekIndex}
          onWeekIndexChange={(wi) => void changeWeek(wi)}
          minWeekIndex={0}
          maxWeekIndex={SCHEDULE_VIEW_WEEK_COUNT - 1}
          templateWeekIndex={SCHEDULE_TEMPLATE_WEEK_INDEX}
        />

        {mode === 'manager' && pendingEmployees.length > 0 ? (
          <View style={styles.pendingBlock}>
            <Text style={styles.pendingLabel}>Pending</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.pendingChips}
            >
              {pendingEmployees.map((emp) => {
                const on = emp.id === activeEmployee.id;
                return (
                  <Pressable
                    key={emp.id}
                    style={[styles.pendingChip, on && styles.pendingChipOn]}
                    onPress={() => void changeEmployee(emp)}
                  >
                    <Text
                      style={[styles.pendingChipText, on && styles.pendingChipTextOn]}
                      numberOfLines={1}
                    >
                      {employeeDisplayName(emp)}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        <View style={styles.statusRow}>
          <StatusBadge status={status} />
          {feedback ? <Text style={styles.feedback}>{feedback}</Text> : null}
        </View>

        {grid ? (
          <AvailabilityMatrixEditor
            staffType={staffType}
            draftRows={draftRows}
            normalized={grid}
            onChange={onGridChange}
            embedInParentScroll
          />
        ) : null}

        <View style={styles.actions}>
          <Pressable style={styles.btnSecondary} onPress={onCheckAll} disabled={busy || !grid}>
            <Text style={styles.btnSecondaryText}>Check all</Text>
          </Pressable>
          {mode === 'manager' ? (
            <>
              <Pressable
                style={[styles.btnPrimary, busy && styles.btnDisabled]}
                disabled={busy || !grid}
                onPress={() => void onManagerSave()}
              >
                <Text style={styles.btnPrimaryText}>{busy ? 'Saving…' : 'Save'}</Text>
              </Pressable>
              {showReviewActions ? (
                <>
                  <Pressable
                    style={[styles.btnPrimary, busy && styles.btnDisabled]}
                    disabled={busy || !grid}
                    onPress={() => void onManagerReview('approve')}
                  >
                    <Text style={styles.btnPrimaryText}>Approve</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.btnSecondary, busy && styles.btnDisabled]}
                    disabled={busy || !grid}
                    onPress={() => void onManagerReview('decline')}
                  >
                    <Text style={styles.btnSecondaryText}>Decline</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          ) : (
            <Pressable
              style={[styles.btnPrimary, busy && styles.btnDisabled]}
              disabled={busy || !grid}
              onPress={() => void onEmployeeSubmit()}
            >
              <Text style={styles.btnPrimaryText}>{busy ? 'Submitting…' : 'Submit'}</Text>
            </Pressable>
          )}
        </View>
      </ScrollView>

      {mode === 'manager' ? (
        <Modal visible={pickerOpen} animationType="slide" presentationStyle="pageSheet">
          <View style={styles.modal}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>Team roster</Text>
              <Pressable onPress={() => setPickerOpen(false)} hitSlop={8}>
                <Text style={styles.modalClose}>Close</Text>
              </Pressable>
            </View>
            <FlatList
              data={roster}
              keyExtractor={(item) => item.id}
              renderItem={({ item }) => {
                const on = item.id === activeEmployee.id;
                const entry = getEmployeeAvailabilityWeekEntry(
                  item,
                  weekIndex,
                  draftRows,
                  staffRequests
                );
                return (
                  <Pressable
                    style={[styles.rosterRow, on && styles.rosterRowOn]}
                    onPress={() => void changeEmployee(item)}
                  >
                    <View style={styles.rosterBody}>
                      <Text style={styles.rosterName}>{employeeDisplayName(item)}</Text>
                      <Text style={styles.rosterMeta}>
                        {staffTypeLabel(item.staffType)}
                        {entry.status === 'submitted' ? ' · Pending' : ''}
                        {entry.status === 'approved' ? ' · Approved' : ''}
                      </Text>
                    </View>
                    {on ? <Text style={styles.rosterCheck}>✓</Text> : null}
                  </Pressable>
                );
              }}
            />
          </View>
        </Modal>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  content: { padding: 16, paddingBottom: 40 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  muted: { color: '#64748b', textAlign: 'center' },
  hint: { fontSize: 14, color: '#475569', marginBottom: 12, lineHeight: 20 },
  pickerBlock: { marginBottom: 12 },
  fieldLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 6,
  },
  employeeSelect: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  employeeSelectText: { flex: 1, fontSize: 16, fontWeight: '700', color: '#0f172a' },
  employeeSelectChevron: { fontSize: 16, color: '#64748b', marginLeft: 8 },
  roleLine: { marginTop: 6, fontSize: 13, color: '#64748b' },
  pendingBlock: {
    marginTop: 10,
    marginBottom: 4,
    paddingVertical: 10,
    paddingHorizontal: 12,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  pendingLabel: {
    fontSize: 11,
    fontWeight: '800',
    color: '#92400e',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  pendingChips: { flexDirection: 'row', gap: 8 },
  pendingChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fcd34d',
    maxWidth: 160,
  },
  pendingChipOn: { backgroundColor: '#fef2f2', borderColor: '#c41230' },
  pendingChipText: { fontSize: 13, fontWeight: '700', color: '#92400e' },
  pendingChipTextOn: { color: '#c41230' },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginTop: 10,
    marginBottom: 4,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
  },
  badgeDraft: { backgroundColor: '#f1f5f9', borderColor: '#cbd5e1' },
  badgeSubmitted: { backgroundColor: '#fffbeb', borderColor: '#fcd34d' },
  badgeApproved: { backgroundColor: '#ecfdf5', borderColor: '#86efac' },
  badgeDeclined: { backgroundColor: '#fef2f2', borderColor: '#fca5a5' },
  badgeText: { fontSize: 12, fontWeight: '800' },
  badgeTextDraft: { color: '#475569' },
  badgeTextSubmitted: { color: '#92400e' },
  badgeTextApproved: { color: '#15803d' },
  badgeTextDeclined: { color: '#b91c1c' },
  feedback: { fontSize: 13, color: '#15803d', fontWeight: '600', flexShrink: 1 },
  actions: { marginTop: 16, gap: 10 },
  btnPrimary: {
    backgroundColor: '#c41230',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
  },
  btnPrimaryText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  btnSecondary: {
    backgroundColor: '#fff',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#e2e8f0',
  },
  btnSecondaryText: { color: '#0f172a', fontWeight: '700', fontSize: 14 },
  btnDisabled: { opacity: 0.55 },
  modal: { flex: 1, backgroundColor: '#fff', paddingTop: 12 },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaef',
  },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  modalClose: { color: '#c41230', fontWeight: '700', fontSize: 16 },
  rosterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e8eaef',
  },
  rosterRowOn: { backgroundColor: '#fef2f2' },
  rosterBody: { flex: 1 },
  rosterName: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  rosterMeta: { fontSize: 13, color: '#64748b', marginTop: 2 },
  rosterCheck: { fontSize: 18, fontWeight: '800', color: '#c41230', marginLeft: 8 },
});
