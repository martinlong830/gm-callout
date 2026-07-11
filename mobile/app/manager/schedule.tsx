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
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { employeeDisplayName, type EmployeeRow } from '../../lib/employees';
import { readStoredTeamStateId } from '../../lib/companySession';
import { broadcastTeamStateChanged } from '../../lib/teamStateSync';
import { supabase } from '../../lib/supabase';
import type {
  AssignmentStore,
  EmployeeLite,
  Restaurant,
  RoleKey,
  ScheduleRow,
} from '../../lib/schedule/types';
import {
  assignPersonToScheduleRow,
  assignmentShell,
  buildAllWeekDayLabels,
  buildCalendarBody,
  buildSchedule,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  getVisibleWeekDays,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  namesForScheduleRowPersonPicker,
  purgeDefaultUnassignedRestaurantAssignments,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  scheduleRowPrimaryPerson,
  STAFF_TYPE_LABELS,
  type CalendarBodyRow,
  type CalendarCell,
} from '../../lib/schedule/engine';

/** Wide enough for a single-line slot time (e.g. 10:00 AM – 7:30 PM) in the cell header. */
const CELL_MIN = 158;
/** Sticky Person column — parity with web `.calendar-row-person-col`. */
const PERSON_COL = 118;
/**
 * Fixed height for role section bars (person sticky + day fill).
 * Both columns render independently, so content-driven height (wrapped title vs
 * single-line invisible mirror) previously made the left side taller.
 */
const SECTION_ROW_H = 40;
/** Gap between role bar and first shift row — keeps bars visually separate from cells. */
const SECTION_GAP_BELOW = 8;
const ROLE_PILL: Record<string, { bg: string; fg: string; border: string }> = {
  'role-kitchen': { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  'role-server': { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
  'role-bartender': { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
};

type RowPersonTarget = { role: RoleKey; trIdx: number };

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

function sectionBg(variant: 'foh' | 'boh' | 'delivery'): string {
  if (variant === 'foh') return '#ecfdf5';
  if (variant === 'delivery') return '#eff6ff';
  return '#fffbeb';
}

/** Role accent — matches web `.calendar-section-*` label color / left border. */
function sectionFg(variant: 'foh' | 'boh' | 'delivery'): string {
  if (variant === 'foh') return '#047857';
  if (variant === 'delivery') return '#1d4ed8';
  return '#92400e';
}

export default function ManagerScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { role, session } = useAuth();
  const { employees, teamState, refetch, loading, applyLocalScheduleAssignments } = useAppData();
  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const [restaurants] = useState<Restaurant[]>(() => defaultRestaurants());
  const [currentRestaurantId, setCurrentRestaurantId] = useState(restaurants[0]?.id ?? 'rp-9');
  const [assignmentStore, setAssignmentStore] = useState<AssignmentStore>(() =>
    assignmentShell(restaurants)
  );
  const [pickerShift, setPickerShift] = useState<ScheduleRow | null>(null);
  const [rowPersonPicker, setRowPersonPicker] = useState<RowPersonTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const visibleDays = useMemo(
    () => getVisibleWeekDays(allWeekDays, weekIndex),
    [allWeekDays, weekIndex]
  );

  const draftScheduleRaw = teamState?.draft_schedule;
  const draftRows = useMemo(
    () => loadDraftFromTeamState(draftScheduleRaw, weekIndex, currentRestaurantId),
    [draftScheduleRaw, weekIndex, currentRestaurantId]
  );

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
        draftScheduleRaw,
        employees: lites,
        restaurants,
        currentRestaurantId,
        assignmentStore,
      }),
    [allWeekDays, draftScheduleRaw, lites, restaurants, currentRestaurantId, assignmentStore]
  );

  const calendarBody = useMemo(
    () => buildCalendarBody(schedule, visibleDays, draftRows),
    [schedule, visibleDays, draftRows]
  );

  const daysWidth = Math.max(Dimensions.get('window').width - PERSON_COL - 16, visibleDays.length * CELL_MIN);

  const persistCloud = useCallback(
    async (store: AssignmentStore) => {
      if (!supabase || role !== 'manager') return;
      setSaving(true);
      try {
        const toSave = JSON.parse(JSON.stringify(store)) as AssignmentStore;
        purgeDefaultUnassignedRestaurantAssignments(toSave, restaurants);
        const teamStateId = await readStoredTeamStateId();
        const up = await supabase.from('team_state').upsert(
          {
            id: teamStateId,
            schedule_assignments: toSave,
          },
          { onConflict: 'id' }
        );
        if (up.error) console.warn('team_state upsert', up.error);
        else {
          await broadcastTeamStateChanged(
            supabase,
            teamStateId,
            ['schedule_assignments'],
            session?.user?.id
          );
          // Local state already has assignments; avoid full hydrate after every edit.
          applyLocalScheduleAssignments(toSave);
        }
      } finally {
        setSaving(false);
      }
    },
    [role, restaurants, session?.user?.id, applyLocalScheduleAssignments]
  );

  const queuePersist = useCallback(
    (store: AssignmentStore) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        void persistCloud(store);
      }, 3000);
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
    applyLocalScheduleAssignments(next);
    queuePersist(next);
    setPickerShift(null);
  }

  function applyRowPersonChoice(target: RowPersonTarget, workerName: string) {
    const next = assignPersonToScheduleRow(
      assignmentStore,
      schedule,
      currentRestaurantId,
      target.role,
      target.trIdx,
      visibleDays,
      workerName,
      lites
    );
    if (next === assignmentStore) {
      setRowPersonPicker(null);
      return;
    }
    setAssignmentStore(next);
    applyLocalScheduleAssignments(next);
    queuePersist(next);
    setRowPersonPicker(null);
  }

  const pickerNames = useMemo(() => {
    if (!pickerShift) return [] as string[];
    const shiftRole = pickerShift.role as RoleKey;
    const names = employees
      .filter((e) => {
        if (e.staffType !== shiftRole) return false;
        const u = e.usualRestaurant || 'both';
        if (u === 'both') return true;
        return u === currentRestaurantId;
      })
      .map(employeeDisplayName)
      .filter(Boolean);
    return ['Unassigned', ...names];
  }, [pickerShift, employees, currentRestaurantId]);

  const rowPickerNames = useMemo(() => {
    if (!rowPersonPicker) return [] as string[];
    const selected = scheduleRowPrimaryPerson(
      schedule,
      rowPersonPicker.role,
      rowPersonPicker.trIdx,
      visibleDays,
      lites,
      currentRestaurantId
    );
    const pool = namesForScheduleRowPersonPicker(lites, rowPersonPicker.role, currentRestaurantId);
    if (selected && selected !== 'Unassigned') {
      const selKey = selected.trim().toLowerCase();
      const inPool = pool.some((n) => n.trim().toLowerCase() === selKey);
      if (!inPool) return ['Unassigned', selected, ...pool];
    }
    return ['Unassigned', ...pool];
  }, [rowPersonPicker, schedule, visibleDays, lites, currentRestaurantId]);

  const modalOpen = !!pickerShift || !!rowPersonPicker;

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
          <ScheduleWeekPicker
            mode="managerNav"
            weekMeta={weekMeta}
            weekIndex={weekIndex}
            onWeekIndexChange={setWeekIndex}
            minWeekIndex={0}
            maxWeekIndex={SCHEDULE_VIEW_WEEK_COUNT - 1}
            templateWeekIndex={SCHEDULE_TEMPLATE_WEEK_INDEX}
          />
        </View>

        <View style={styles.locRow}>
          <Text style={styles.toolbarLabel}>Location</Text>
          <View style={styles.locRowContent}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.locChipsScroll}
              contentContainerStyle={styles.chipsRow}
            >
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
            <View style={styles.locActions}>
              {loading ? <ActivityIndicator /> : null}
              {saving ? <Text style={styles.syncHint}>Saving…</Text> : null}
              <Pressable onPress={() => void refetch()} style={styles.refreshBtn}>
                <Text style={styles.refreshTxt}>Refresh</Text>
              </Pressable>
            </View>
          </View>
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

        <View style={styles.matrix}>
          <View style={[styles.personCol, { width: PERSON_COL }]}>
            <View style={styles.personTh}>
              <Text style={styles.thFull}>PERSON</Text>
              <Text style={styles.thSub}>Row assignee</Text>
            </View>
            {calendarBody.map((row, ri) => (
              <PersonColRow
                key={`p-${ri}`}
                row={row}
                schedule={schedule}
                visibleDays={visibleDays}
                employees={lites}
                restaurantId={currentRestaurantId}
                onOpenRowPerson={setRowPersonPicker}
              />
            ))}
          </View>

          <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator style={styles.daysScroll}>
            <View style={{ width: daysWidth, paddingBottom: 16 }}>
              <View style={[styles.headerRow, { width: daysWidth }]}>
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
        </View>
      </ScrollView>

      <Modal visible={modalOpen} animationType="slide" transparent>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setPickerShift(null);
            setRowPersonPicker(null);
          }}
        >
          <Pressable style={styles.modalPanel} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>
              {rowPersonPicker ? 'Assign Row Person' : 'Assign Shift'}
            </Text>
            {rowPersonPicker ? (
              <Text style={styles.modalSub} numberOfLines={3}>
                {STAFF_TYPE_LABELS[rowPersonPicker.role]} · row {rowPersonPicker.trIdx + 1} · all
                staffed days this week
              </Text>
            ) : pickerShift ? (
              <Text style={styles.modalSub} numberOfLines={3}>
                {STAFF_TYPE_LABELS[pickerShift.role as RoleKey]} · {pickerShift.day} ·{' '}
                {pickerShift.timeLabel}
              </Text>
            ) : null}
            <FlatList
              data={rowPersonPicker ? rowPickerNames : pickerNames}
              keyExtractor={(item) => item}
              style={styles.modalList}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.modalRow}
                  onPress={() => {
                    if (rowPersonPicker) applyRowPersonChoice(rowPersonPicker, item);
                    else if (pickerShift) applyWorkerChoice(pickerShift, item);
                  }}
                >
                  <Text style={styles.modalRowText}>{item}</Text>
                </Pressable>
              )}
            />
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setPickerShift(null);
                setRowPersonPicker(null);
              }}
            >
              <Text style={styles.modalCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function PersonColRow({
  row,
  schedule,
  visibleDays,
  employees,
  restaurantId,
  onOpenRowPerson,
}: {
  row: CalendarBodyRow;
  schedule: ScheduleRow[];
  visibleDays: string[];
  employees: EmployeeLite[];
  restaurantId: string;
  onOpenRowPerson: (t: RowPersonTarget) => void;
}) {
  if (row.kind === 'section') {
    const fg = sectionFg(row.variant);
    return (
      <View
        style={[
          styles.personSection,
          {
            backgroundColor: sectionBg(row.variant),
            borderLeftColor: fg,
          },
        ]}
      >
        <Text style={[styles.sectionText, { color: fg }]} numberOfLines={2}>
          {row.title}
        </Text>
      </View>
    );
  }

  if (row.kind !== 'cells') return null;

  const selected = scheduleRowPrimaryPerson(
    schedule,
    row.role,
    row.trIdx,
    visibleDays,
    employees,
    restaurantId
  );
  const label = selected && selected !== 'Unassigned' ? selected : 'Unassigned';

  return (
    <View style={styles.personCell}>
      <Pressable
        style={styles.personSelect}
        onPress={() => onOpenRowPerson({ role: row.role, trIdx: row.trIdx })}
        accessibilityRole="button"
        accessibilityLabel={`Person for ${STAFF_TYPE_LABELS[row.role]} row ${row.trIdx + 1}`}
      >
        <Text style={styles.personSelectText} numberOfLines={2}>
          {label}
        </Text>
      </Pressable>
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
    // Empty fill — fixed height matches person sticky; do not mirror title text
    // (narrow person col wraps; wide day strip does not → height mismatch).
    return <View style={[styles.sectionRow, { backgroundColor: sectionBg(row.variant) }]} />;
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
        <Text style={styles.slotTime}>{cell.timeLabel}</Text>
        <Text style={styles.dayoffLabel}>DAY-OFF</Text>
      </View>
    );
  }
  const rd = ROLE_PILL[cell.shift.roleClass] || ROLE_PILL['role-kitchen'];
  return (
    <Pressable
      style={[
        styles.cellInner,
        {
          backgroundColor: rd.bg,
          borderColor: rd.border,
          borderLeftColor: rd.fg,
        },
      ]}
      onPress={() => onOpenShift(cell.shift)}
    >
      <Text style={styles.slotTime}>{cell.timeLabel}</Text>
      {cell.breakText ? <Text style={styles.slotBreak}>{cell.breakText}</Text> : null}
      <Text style={styles.slotHours}>{cell.hours}h</Text>
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
  locRowContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locChipsScroll: { flex: 1 },
  locActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
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
  syncHint: { fontSize: 13, color: '#64748b' },
  refreshBtn: { paddingVertical: 4 },
  refreshTxt: { fontSize: 14, color: '#c41230', fontWeight: '700' },
  matrix: { flexDirection: 'row', alignItems: 'flex-start', paddingLeft: 4 },
  personCol: {
    backgroundColor: '#fff',
    zIndex: 2,
    /* No grey tint / heavy separator — parity with cleaned web person column. */
  },
  personTh: {
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    minHeight: 52,
    justifyContent: 'flex-end',
  },
  personSection: {
    height: SECTION_ROW_H,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 3,
    borderColor: '#e8eaef',
    justifyContent: 'center',
    marginBottom: SECTION_GAP_BELOW,
  },
  personCell: {
    minHeight: 80,
    padding: 6,
    borderBottomWidth: 1,
    borderColor: '#eef2f7',
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
  personSelect: {
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 8,
    minHeight: 44,
    justifyContent: 'center',
  },
  personSelectText: { fontSize: 12, fontWeight: '600', color: '#0f172a' },
  daysScroll: { flexGrow: 1, flexShrink: 1 },
  headerRow: { flexDirection: 'row', marginBottom: 0 },
  th: { paddingVertical: 10, paddingHorizontal: 4, borderBottomWidth: 1, borderColor: '#e2e8f0', minHeight: 52, justifyContent: 'flex-end' },
  thFull: { fontSize: 11, fontWeight: '800', color: '#0f172a', letterSpacing: 0.6 },
  thSub: { marginTop: 4, fontSize: 11, color: '#64748b', fontWeight: '500' },
  sectionRow: {
    height: SECTION_ROW_H,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8eaef',
    marginBottom: SECTION_GAP_BELOW,
  },
  sectionText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: 13,
  },
  dataRow: { flexDirection: 'row', borderBottomWidth: 1, borderColor: '#eef2f7', backgroundColor: '#fff' },
  cell: { minHeight: 80, borderRightWidth: 1, borderColor: '#f1f5f9', padding: 4 },
  cellInner: {
    flex: 1,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  cellInnerMuted: { flex: 1, opacity: 0.85, justifyContent: 'center' },
  slotTime: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  slotBreak: { fontSize: 10, color: '#64748b', marginTop: 2 },
  slotHours: { fontSize: 11, fontWeight: '700', color: '#334155', marginTop: 1 },
  dayoffLabel: { fontSize: 11, fontWeight: '700', color: '#94a3b8', marginTop: 6 },
  dayoffSmall: { fontSize: 11, fontWeight: '700', color: '#cbd5e1', textAlign: 'center' },
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
