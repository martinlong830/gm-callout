import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dimensions,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { useAppData } from '../../contexts/AppDataContext';
import type { EmployeeRow } from '../../lib/employees';
import { formatScheduleWeekRangeLabel } from '../../lib/schedule/employeeShiftDisplay';
import type { AssignmentStore, EmployeeLite, Restaurant, RoleKey, ScheduleRow } from '../../lib/schedule/types';
import {
  assignmentShell,
  buildAllWeekDayLabels,
  buildCalendarBody,
  buildSchedule,
  buildWeeksFromMonday,
  defaultRestaurants,
  ensureRollingFutureAssignments,
  getScheduleAnchorMondayDate,
  getVisibleWeekDays,
  isScheduleWeekIndexPublished,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  normalizeSchedulePublishedMap,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  scheduleRowPrimaryPerson,
  seedDefaultPublishedWeeks,
  type CalendarBodyRow,
} from '../../lib/schedule/engine';

const CELL_MIN = 158;
const PERSON_COL = 118;
const SECTION_ROW_H = 40;
const SECTION_GAP_BELOW = 8;
const HEADER_ROW_H = 52;
const DATA_ROW_MIN_H = 80;
const ROLE_PILL: Record<string, { bg: string; fg: string; border: string }> = {
  'role-kitchen': { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  'role-server': { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
  'role-bartender': { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
};

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

function sectionFg(variant: 'foh' | 'boh' | 'delivery'): string {
  if (variant === 'foh') return '#047857';
  if (variant === 'delivery') return '#1d4ed8';
  return '#92400e';
}

/** Read-only master schedule for employees — same SoT as manager, no editing. */
export default function EmployeeScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { employees, teamState, loading } = useAppData();
  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const [restaurants] = useState<Restaurant[]>(() => defaultRestaurants());
  const [currentRestaurantId, setCurrentRestaurantId] = useState(restaurants[0]?.id ?? 'rp-9');
  const [assignmentStore, setAssignmentStore] = useState<AssignmentStore>(() =>
    assignmentShell(restaurants)
  );
  const dayScrollRef = useRef<ScrollView | null>(null);

  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const visibleDays = useMemo(
    () => getVisibleWeekDays(allWeekDays, weekIndex),
    [allWeekDays, weekIndex]
  );

  const publishedMap = useMemo(() => {
    const map = normalizeSchedulePublishedMap(teamState?.schedule_published);
    seedDefaultPublishedWeeks(map, weekMeta);
    return map;
  }, [teamState?.schedule_published, weekMeta]);

  const weekPublished = isScheduleWeekIndexPublished(publishedMap, weekMeta, weekIndex);

  const draftScheduleRaw = teamState?.draft_schedule;
  const draftRows = useMemo(
    () => loadDraftFromTeamState(draftScheduleRaw, weekIndex, currentRestaurantId),
    [draftScheduleRaw, weekIndex, currentRestaurantId]
  );

  useEffect(() => {
    dayScrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [weekIndex, currentRestaurantId]);

  useEffect(() => {
    const ids = restaurants.map((r) => r.id);
    const shell = assignmentShell(restaurants);
    const merged = mergeRemoteAssignments(shell, teamState?.schedule_assignments, ids);
    const rolled = ensureRollingFutureAssignments(merged, restaurants);
    setAssignmentStore(rolled.store);
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

  const daysWidth = Math.max(
    Dimensions.get('window').width - PERSON_COL - 16,
    visibleDays.length * CELL_MIN
  );

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      {/* Frozen chrome — week / location / legend stay put (grid scrolls below). */}
      <View style={styles.chrome}>
        <View style={styles.brandRow}>
          <Image
            source={require('../../assets/red-poke-logo.png')}
            style={styles.brandLogo}
            accessibilityLabel="Red Poke"
          />
        </View>

        <Text style={styles.hint}>Full team schedule — view only.</Text>

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

        {weekPublished ? (
          <View style={styles.legend}>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-bartender'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-bartender'].fg }]}>
                Front of the House
              </Text>
            </View>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-kitchen'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-kitchen'].fg }]}>
                Back of the House
              </Text>
            </View>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-server'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-server'].fg }]}>
                Delivery/Dishwasher
              </Text>
            </View>
          </View>
        ) : null}
      </View>

      {!weekPublished ? (
        <View style={styles.unpublished}>
          <Text style={styles.unpublishedTitle}>Not published yet</Text>
          <Text style={styles.unpublishedBody}>
            Week {formatScheduleWeekRangeLabel(weekMeta, weekIndex)} has not been published. Your
            manager will notify you when it is ready.
          </Text>
        </View>
      ) : (
        /*
         * Same scroll model as manager schedule: one vertical ScrollView for the
         * whole matrix (Person + day headers travel with rows). Nested horizontal
         * ScrollView only for day columns. Avoids a flex-bounded body ScrollView
         * that failed to scroll after the sticky-header split.
         */
        <ScrollView
          style={styles.gridScroll}
          contentContainerStyle={styles.gridScrollContent}
          nestedScrollEnabled
          showsVerticalScrollIndicator
          keyboardShouldPersistTaps="handled"
        >
          {loading && !teamState ? <Text style={styles.muted}>Loading schedule…</Text> : null}

          <View style={styles.matrix}>
            <View style={styles.matrixInner}>
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
                  />
                ))}
              </View>

              <ScrollView
                ref={dayScrollRef}
                horizontal
                nestedScrollEnabled
                showsHorizontalScrollIndicator
                style={styles.dayLane}
                contentContainerStyle={styles.dayLaneContent}
                keyboardShouldPersistTaps="handled"
              >
                <View style={{ width: daysWidth }}>
                  <View style={styles.headerDays}>
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
                    <DayColRow key={`d-${ri}`} row={row} daysWidth={daysWidth} />
                  ))}
                </View>
              </ScrollView>
            </View>
          </View>
        </ScrollView>
      )}
    </View>
  );
}

function PersonColRow({
  row,
  schedule,
  visibleDays,
  employees,
  restaurantId,
}: {
  row: CalendarBodyRow;
  schedule: ScheduleRow[];
  visibleDays: string[];
  employees: EmployeeLite[];
  restaurantId: string;
}) {
  if (row.kind === 'section') {
    const bg = sectionBg(row.variant);
    const fg = sectionFg(row.variant);
    return (
      <View
        style={[
          styles.personSection,
          styles.sectionMatrixRow,
          { backgroundColor: bg, borderLeftColor: fg },
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
    <View style={[styles.personCell, styles.dataMatrixRow]}>
      <View style={styles.personReadonly}>
        <Text style={styles.personSelectText} numberOfLines={2}>
          {label}
        </Text>
      </View>
    </View>
  );
}

function DayColRow({ row, daysWidth }: { row: CalendarBodyRow; daysWidth: number }) {
  if (row.kind === 'section') {
    const bg = sectionBg(row.variant);
    return (
      <View
        style={[
          styles.sectionDayFill,
          styles.sectionMatrixRow,
          { width: daysWidth, backgroundColor: bg },
        ]}
      />
    );
  }
  if (row.kind !== 'cells') return null;
  return (
    <View style={[styles.dataMatrixRow, styles.dayRow, { width: daysWidth }]}>
      {row.cells.map((cell, ci) => {
        if (cell.kind === 'empty') {
          return <View key={ci} style={[styles.cell, styles.cellEmpty, { width: CELL_MIN }]} />;
        }
        if (cell.kind === 'dayoff') {
          return (
            <View key={ci} style={[styles.cell, styles.cellDayoff, { width: CELL_MIN }]}>
              <Text style={styles.cellTime}>{cell.timeLabel}</Text>
              <Text style={styles.cellDayoffLabel}>DAY-OFF</Text>
            </View>
          );
        }
        const pill = ROLE_PILL[cell.shift.roleClass] || ROLE_PILL['role-server'];
        return (
          <View
            key={ci}
            style={[
              styles.cell,
              styles.cellShift,
              { width: CELL_MIN, borderColor: pill.border, backgroundColor: pill.bg },
            ]}
          >
            <Text style={[styles.cellTime, { color: pill.fg }]}>{cell.timeLabel}</Text>
            <Text style={styles.cellBreak}>{cell.breakText}</Text>
            <Text style={styles.cellHours}>{cell.hours}</Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  chrome: { flexShrink: 0, backgroundColor: '#f4f6f8', zIndex: 2 },
  brandRow: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  brandLogo: { width: 72, height: 72, resizeMode: 'contain' },
  hint: { paddingHorizontal: 16, color: '#64748b', fontSize: 13, marginBottom: 8 },
  toolbar: { paddingHorizontal: 16, marginBottom: 8 },
  toolbarLabel: { fontSize: 11, fontWeight: '700', color: '#666', marginBottom: 6, textTransform: 'uppercase' },
  locRow: { paddingHorizontal: 16, marginBottom: 10 },
  chipsRow: { gap: 8, paddingRight: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  chipActive: { backgroundColor: '#c41230', borderColor: '#c41230' },
  chipText: { fontSize: 13, fontWeight: '600', color: '#333' },
  chipTextActive: { color: '#fff' },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: 16, marginBottom: 8 },
  legendPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: '#fff',
  },
  legendTxt: { fontSize: 11, fontWeight: '600' },
  unpublished: {
    marginHorizontal: 16,
    marginTop: 8,
    padding: 16,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  unpublishedTitle: { fontSize: 16, fontWeight: '700', color: '#111', marginBottom: 6 },
  unpublishedBody: { fontSize: 14, color: '#555', lineHeight: 20 },
  muted: { paddingHorizontal: 16, color: '#888', marginBottom: 8 },
  /* flex:1 + minHeight:0 so this ScrollView gets a real viewport under frozen chrome */
  gridScroll: { flex: 1, minHeight: 0 },
  gridScrollContent: { flexGrow: 1, paddingBottom: 24 },
  matrix: { paddingHorizontal: 8 },
  matrixInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  personCol: {
    flexShrink: 0,
    backgroundColor: '#fff',
  },
  personTh: {
    height: HEADER_ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
  },
  thFull: { fontSize: 11, fontWeight: '700', color: '#333' },
  thSub: { fontSize: 10, color: '#888', marginTop: 2 },
  personSection: {
    height: SECTION_ROW_H,
    marginBottom: SECTION_GAP_BELOW,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderLeftWidth: 3,
  },
  sectionMatrixRow: {},
  sectionText: { fontSize: 10, fontWeight: '700' },
  personCell: {
    minHeight: DATA_ROW_MIN_H,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f4',
  },
  dataMatrixRow: {},
  personReadonly: {
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: '#f8fafc',
  },
  personSelectText: { fontSize: 12, fontWeight: '600', color: '#111' },
  dayLane: { flex: 1 },
  dayLaneContent: { flexGrow: 1 },
  headerDays: { flexDirection: 'row', height: HEADER_ROW_H },
  th: {
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
    backgroundColor: '#fff',
  },
  sectionDayFill: { height: SECTION_ROW_H, marginBottom: SECTION_GAP_BELOW },
  dayRow: { flexDirection: 'row', minHeight: DATA_ROW_MIN_H },
  cell: {
    minHeight: DATA_ROW_MIN_H,
    padding: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f4',
    borderRightWidth: 1,
    borderRightColor: '#f0f2f4',
  },
  cellEmpty: { backgroundColor: '#fafafa' },
  cellDayoff: { backgroundColor: '#f8fafc' },
  cellDayoffLabel: { fontSize: 10, color: '#94a3b8', marginTop: 4, fontWeight: '600' },
  cellShift: { borderWidth: 1, borderRadius: 4, margin: 2 },
  cellTime: { fontSize: 11, fontWeight: '700' },
  cellBreak: { fontSize: 10, color: '#64748b', marginTop: 2 },
  cellHours: { fontSize: 10, color: '#334155', marginTop: 2, fontWeight: '600' },
});
