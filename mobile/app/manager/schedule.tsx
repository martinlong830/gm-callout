import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { employeeDisplayName, type EmployeeRow } from '../../lib/employees';
import { TEAM_STATE_ROW_ID } from '../../lib/constants';
import { supabase } from '../../lib/supabase';
import type {
  AssignmentStore,
  EmployeeLite,
  Restaurant,
  RoleKey,
  ScheduleRow,
} from '../../lib/schedule/types';
import {
  assignmentShell,
  buildAllWeekDayLabels,
  buildCalendarBody,
  buildSchedule,
  buildWeeksFromMonday,
  defaultRestaurants,
  getThisMondayDate,
  getVisibleWeekDays,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  SCHEDULE_VIEW_WEEK_COUNT,
  STAFF_TYPE_LABELS,
  type CalendarBodyRow,
  type CalendarCell,
} from '../../lib/schedule/engine';

/** Wide enough for a single-line slot time (e.g. 10:00 AM – 7:30 PM) in the cell header. */
const CELL_MIN = 158;
const ROLE_PILL: Record<string, { bg: string; fg: string; border: string }> = {
  'role-kitchen': { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  'role-server': { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
  'role-bartender': { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
};

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function weekChipLabel(weekMeta: ReturnType<typeof buildWeeksFromMonday>, w: number): string {
  const i0 = w * 7;
  const m0 = weekMeta[i0];
  const m6 = weekMeta[Math.min(i0 + 6, weekMeta.length - 1)];
  if (m0 && m6) {
    const d0 = m0.label.replace(/^[A-Za-z]+\s+/, '');
    const d6 = m6.label.replace(/^[A-Za-z]+\s+/, '');
    return `Week ${w + 1} (${d0} – ${d6})`;
  }
  return `Week ${w + 1}`;
}

export default function ManagerScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { role } = useAuth();
  const { employees, teamState, refetch, loading } = useAppData();
  const [weekIndex, setWeekIndex] = useState(0);
  const [restaurants] = useState<Restaurant[]>(() => defaultRestaurants());
  const [currentRestaurantId, setCurrentRestaurantId] = useState(restaurants[0]?.id ?? 'rp-9');
  const [assignmentStore, setAssignmentStore] = useState<AssignmentStore>(() =>
    assignmentShell(restaurants)
  );
  const [pickerShift, setPickerShift] = useState<ScheduleRow | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const weekMeta = useMemo(() => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getThisMondayDate()), []);
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const visibleDays = useMemo(
    () => getVisibleWeekDays(allWeekDays, weekIndex),
    [allWeekDays, weekIndex]
  );

  const draftRows = useMemo(() => {
    const dr = teamState?.draft_schedule;
    return loadDraftFromTeamState(dr);
  }, [teamState]);

  useEffect(() => {
    const ids = restaurants.map((r) => r.id);
    const raw = teamState?.schedule_assignments;
    const shell = assignmentShell(restaurants);
    setAssignmentStore(mergeRemoteAssignments(shell, raw, ids));
  }, [teamState, restaurants]);

  const lites = useMemo(() => employees.map(toLite), [employees]);

  const schedule = useMemo(
    () =>
      buildSchedule({
        allWeekDays,
        draftRows,
        employees: lites,
        restaurants,
        currentRestaurantId,
        assignmentStore,
      }),
    [allWeekDays, draftRows, lites, restaurants, currentRestaurantId, assignmentStore]
  );

  const calendarBody = useMemo(
    () => buildCalendarBody(schedule, visibleDays, draftRows),
    [schedule, visibleDays, draftRows]
  );

  const tableWidth = Math.max(Dimensions.get('window').width, visibleDays.length * CELL_MIN + 24);

  const persistCloud = useCallback(
    async (store: AssignmentStore) => {
      if (!supabase || role !== 'manager') return;
      setSaving(true);
      try {
        const cur = await supabase.from('team_state').select('*').eq('id', TEAM_STATE_ROW_ID).maybeSingle();
        if (cur.error || !cur.data) return;
        const row = cur.data as Record<string, unknown>;
        const up = await supabase.from('team_state').upsert({
          id: row.id,
          schedule_assignments: store,
          schedule_templates: row.schedule_templates ?? [],
          draft_schedule: row.draft_schedule ?? {},
          messaging_templates: row.messaging_templates ?? { voice: '' },
          current_restaurant_id: String(row.current_restaurant_id ?? 'rp-9'),
          callout_history: row.callout_history ?? [],
        });
        if (up.error) console.warn('team_state upsert', up.error);
        else void refetch();
      } finally {
        setSaving(false);
      }
    },
    [role, refetch]
  );

  const queuePersist = useCallback(
    (store: AssignmentStore) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void persistCloud(store);
      }, 900);
    },
    [persistCloud]
  );

  function applyWorkerChoice(shift: ScheduleRow, workerName: string) {
    const list =
      workerName === 'Unassigned' ? ['Unassigned'] : [workerName].filter(Boolean);
    const next = { ...assignmentStore };
    if (!next[currentRestaurantId]) next[currentRestaurantId] = {};
    next[currentRestaurantId] = { ...next[currentRestaurantId], [shift.id]: list };
    setAssignmentStore(next);
    queuePersist(next);
    setPickerShift(null);
  }

  const pickerNames = useMemo(() => {
    if (!pickerShift) return [] as string[];
    const role = pickerShift.role as RoleKey;
    const names = employees
      .filter((e) => e.staffType === role)
      .map(employeeDisplayName)
      .filter(Boolean);
    const u = ['Unassigned', ...names];
    return u;
  }, [pickerShift, employees]);

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <ScrollView
        style={styles.outerScroll}
        contentContainerStyle={styles.outerScrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
      >
        <View style={styles.brandRow}>
          <Image
            source={require('../../assets/red-poke-logo.png')}
            style={styles.brandLogo}
            accessibilityLabel="Red Poke"
          />
        </View>

        <View style={styles.toolbar}>
          <Text style={styles.toolbarLabel}>Week</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {Array.from({ length: SCHEDULE_VIEW_WEEK_COUNT }, (_, w) => (
              <Pressable
                key={w}
                onPress={() => setWeekIndex(w)}
                style={[styles.chip, weekIndex === w && styles.chipActive]}
              >
                <Text style={[styles.chipText, weekIndex === w && styles.chipTextActive]}>
                  {weekChipLabel(weekMeta, w)}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.locRow}>
          <Text style={styles.toolbarLabel}>Location</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {restaurants.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setCurrentRestaurantId(r.id)}
                style={[styles.chip, currentRestaurantId === r.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, currentRestaurantId === r.id && styles.chipTextActive]}>
                  {r.shortLabel || r.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.legend}>
          <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-bartender'].border }]}>
            <Text style={[styles.legendTxt, { color: ROLE_PILL['role-bartender'].fg }]}>Front of the House</Text>
          </View>
          <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-kitchen'].border }]}>
            <Text style={[styles.legendTxt, { color: ROLE_PILL['role-kitchen'].fg }]}>Back of the House</Text>
          </View>
          <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-server'].border }]}>
            <Text style={[styles.legendTxt, { color: ROLE_PILL['role-server'].fg }]}>Delivery/Dishwasher</Text>
          </View>
        </View>

        <View style={styles.syncRow}>
          {loading ? <ActivityIndicator /> : null}
          {saving ? <Text style={styles.syncHint}>Saving…</Text> : null}
          <Pressable onPress={() => void refetch()} style={styles.refreshBtn}>
            <Text style={styles.refreshTxt}>Refresh</Text>
          </Pressable>
        </View>

        <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator>
          <View style={{ width: tableWidth, paddingHorizontal: 8, paddingBottom: 16 }}>
            <View style={[styles.headerRow, { width: tableWidth - 16 }]}>
              {visibleDays.map((dayStr) => {
                const meta = weekMeta.find((m) => m.label === dayStr);
                const parts = dayStr.split(' ');
                const dow = parts[0] || '';
                const rest = parts.slice(1).join(' ');
                return (
                  <View key={dayStr} style={[styles.th, { width: CELL_MIN }]}>
                    <Text style={styles.thFull}>{meta?.dayNameUpper || dow.toUpperCase()}</Text>
                    <Text style={styles.thSub}>{rest}</Text>
                  </View>
                );
              })}
            </View>

            {calendarBody.map((row, ri) => (
              <CalendarRowView key={ri} row={row} onOpenShift={setPickerShift} />
            ))}
          </View>
        </ScrollView>
      </ScrollView>

      <Modal visible={!!pickerShift} animationType="slide" transparent>
        <Pressable style={styles.modalBackdrop} onPress={() => setPickerShift(null)}>
          <Pressable style={styles.modalPanel} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>Assign Shift</Text>
            {pickerShift ? (
              <Text style={styles.modalSub} numberOfLines={3}>
                {STAFF_TYPE_LABELS[pickerShift.role as RoleKey]} · {pickerShift.day} · {pickerShift.timeLabel}
              </Text>
            ) : null}
            <FlatList
              data={pickerNames}
              keyExtractor={(item) => item}
              style={styles.modalList}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.modalRow}
                  onPress={() => pickerShift && applyWorkerChoice(pickerShift, item)}
                >
                  <Text style={styles.modalRowText}>{item}</Text>
                </Pressable>
              )}
            />
            <Pressable style={styles.modalCancel} onPress={() => setPickerShift(null)}>
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function CalendarRowView({
  row,
  onOpenShift,
}: {
  row: CalendarBodyRow;
  onOpenShift: (s: ScheduleRow) => void;
}) {
  if (row.kind === 'section') {
    const bg =
      row.variant === 'foh'
        ? '#ecfdf5'
        : row.variant === 'delivery'
          ? '#eff6ff'
          : '#fffbeb';
    return (
      <View style={[styles.sectionRow, { backgroundColor: bg }]}>
        <Text style={styles.sectionText}>{row.title}</Text>
      </View>
    );
  }

  if (row.kind !== 'cells') return null;

  return (
    <View style={styles.dataRow}>
      {row.cells.map((cell, ci) => (
        <View key={ci} style={[styles.cell, { width: CELL_MIN }]}>
          <CalendarCellView cell={cell} onOpenShift={onOpenShift} />
        </View>
      ))}
    </View>
  );
}

function CalendarCellView({
  cell,
  onOpenShift,
}: {
  cell: CalendarCell;
  onOpenShift: (s: ScheduleRow) => void;
}) {
  if (cell.kind === 'empty') {
    return (
      <View style={styles.cellInnerMuted}>
        <Text style={styles.dayoffSmall}>DAY-OFF</Text>
      </View>
    );
  }
  if (cell.kind === 'dayoff') {
    return (
      <View style={styles.cellInnerMuted}>
        <Text style={styles.slotTime} numberOfLines={1} ellipsizeMode="tail">
          {cell.timeLabel}
        </Text>
        <Text style={styles.dayoffLabel}>DAY-OFF</Text>
      </View>
    );
  }
  const rd = ROLE_PILL[cell.shift.roleClass] || ROLE_PILL['role-kitchen'];
  const names = cell.workers.filter((w) => w && w !== 'Unassigned');
  const label = names.length ? names.join(', ') : 'Unassigned';
  return (
    <Pressable style={styles.cellInner} onPress={() => onOpenShift(cell.shift)}>
      <Text style={styles.slotTime} numberOfLines={1} ellipsizeMode="tail">
        {cell.timeLabel}
      </Text>
      <Text style={styles.slotBreak} numberOfLines={2}>
        {cell.breakText}
      </Text>
      <Text style={styles.slotHours}>{cell.hours}h</Text>
      <View style={[styles.pill, { backgroundColor: rd.bg, borderColor: rd.border }]}>
        <Text style={[styles.pillText, { color: rd.fg }]} numberOfLines={3}>
          {label}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  outerScroll: { flex: 1 },
  outerScrollContent: { flexGrow: 1, paddingBottom: 12 },
  brandRow: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 2 },
  brandLogo: { width: 52, height: 52, resizeMode: 'contain' },
  toolbar: { paddingHorizontal: 12, paddingTop: 8 },
  locRow: { paddingHorizontal: 12, marginTop: 6 },
  toolbarLabel: { fontSize: 11, fontWeight: '700', color: '#64748b', marginBottom: 6, textTransform: 'uppercase' },
  chipsRow: { flexDirection: 'row', gap: 8, paddingBottom: 4 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  chipActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  chipText: { fontSize: 13, color: '#334155', fontWeight: '500' },
  chipTextActive: { color: '#c41230', fontWeight: '700' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 12, paddingVertical: 10 },
  legendPill: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, backgroundColor: '#fff' },
  legendTxt: { fontSize: 11, fontWeight: '600' },
  syncRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingBottom: 8,
  },
  syncHint: { fontSize: 13, color: '#64748b' },
  refreshBtn: { marginLeft: 'auto' },
  refreshTxt: { fontSize: 14, color: '#c41230', fontWeight: '700' },
  headerRow: { flexDirection: 'row', marginBottom: 4 },
  th: { paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderColor: '#e2e8f0' },
  thFull: { fontSize: 11, fontWeight: '800', color: '#0f172a', letterSpacing: 0.6 },
  thSub: { marginTop: 4, fontSize: 11, color: '#64748b', fontWeight: '500' },
  sectionRow: {
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8eaef',
  },
  sectionText: { fontSize: 11, fontWeight: '700', color: '#64748b', letterSpacing: 1 },
  dataRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#eef2f7', backgroundColor: '#fff' },
  cell: { minHeight: 140, borderRightWidth: 1, borderColor: '#f1f5f9', padding: 6 },
  cellInner: { flex: 1 },
  cellInnerMuted: { flex: 1, opacity: 0.85, justifyContent: 'center' },
  slotTime: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  slotBreak: { fontSize: 10, color: '#64748b', marginTop: 3 },
  slotHours: { fontSize: 11, fontWeight: '700', color: '#334155', marginTop: 2 },
  dayoffLabel: { fontSize: 11, fontWeight: '700', color: '#94a3b8', marginTop: 6 },
  dayoffSmall: { fontSize: 11, fontWeight: '700', color: '#cbd5e1', textAlign: 'center' },
  pill: { marginTop: 8, paddingVertical: 6, paddingHorizontal: 6, borderRadius: 8, borderWidth: 1 },
  pillText: { fontSize: 11, fontWeight: '600' },
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  modalPanel: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    maxHeight: '55%',
  },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  modalSub: { fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 12 },
  modalList: { maxHeight: 280 },
  modalRow: { paddingVertical: 14, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  modalRowText: { fontSize: 16, color: '#0f172a' },
  modalCancel: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  modalCancelText: { fontSize: 16, color: '#c41230', fontWeight: '700' },
});
