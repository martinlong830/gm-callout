import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useLocalSearchParams, type ErrorBoundaryProps } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAppData } from '../../contexts/AppDataContext';
import { useI18n } from '../../contexts/LocaleContext';
import {
  employeePrimaryLocationId,
  filterRestaurantsForEmployeeSchedule,
  managerScheduleMainRestaurantId,
  orderRestaurantsMainFirst,
  type EmployeeRow,
} from '../../lib/employees';
import { formatScheduleWeekRangeLabel } from '../../lib/schedule/employeeShiftDisplay';
import type { AssignmentStore, EmployeeLite, RoleKey, ScheduleRow } from '../../lib/schedule/types';
import {
  buildAllWeekDayLabels,
  buildCalendarBody,
  buildOtherStoreDayLabelMap,
  buildSchedule,
  buildWeeksFromMonday,
  computeScheduleRowWeekTotals,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  getVisibleWeekDays,
  hydrateScheduleAssignmentsFromTeamState,
  isScheduleWeekIndexPublished,
  loadDraftFromTeamState,
  normalizeSchedulePublishedMap,
  displayBreakAnnotation,
  formatScheduleDayHoursLabel,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  scheduleRowPrimaryPerson,
  seedDefaultPublishedWeeks,
  type CalendarBodyRow,
  type CalendarCell,
} from '../../lib/schedule/engine';
import { readSlotOrderByRestaurantForWeek } from '../../lib/schedule/slotOrder';
import { getPayWeekBoundsForMonday } from '../../lib/timecards/payWeek';
import { restaurantShortLabelForId } from '../../lib/timecards/restaurantAttribution';
import { loadWeekExtrasSlice } from '../../lib/timecards/weekExtras';
import {
  getEmployeeBorrowedRestaurantSync,
  restaurantShortLabel as borrowRestaurantShortLabel,
} from '../../lib/timecards/weekBorrow';

const CELL_MIN = 158;
const PERSON_COL = 118;
const SIDE_TOTALS_W = 68;
/**
 * Fixed heights — Person sticky + day columns are separate trees, so minHeight
 * lets shift cells grow while name cells stay short (misalignment when scrolling).
 * Match manager schedule: shared fixed height so rows cannot diverge.
 */
const SECTION_ROW_H = 40;
const SECTION_GAP_BELOW = 8;
const HEADER_ROW_H = 52;
const DATA_ROW_H = 80;
const ROLE_PILL: Record<string, { bg: string; fg: string; border: string }> = {
  'role-kitchen': { bg: '#fffbeb', fg: '#92400e', border: '#fde68a' },
  'role-server': { bg: '#eff6ff', fg: '#1d4ed8', border: '#bfdbfe' },
  'role-bartender': { bg: '#ecfdf5', fg: '#047857', border: '#a7f3d0' },
};

function pillForRole(role: RoleKey) {
  if (role === 'Bartender') return ROLE_PILL['role-bartender'];
  if (role === 'Server') return ROLE_PILL['role-server'];
  return ROLE_PILL['role-kitchen'];
}

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: e.staffType as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
    primaryLocationId: employeePrimaryLocationId(e),
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
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function EmployeeScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { t, staffTypeLabel } = useI18n();
  const { myEmployee, employees, teamState, loading } = useAppData();
  const params = useLocalSearchParams<{ weekMondayIso?: string }>();
  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const allRestaurants = useMemo(() => defaultRestaurants(), []);
  const [borrowByEmpId, setBorrowByEmpId] = useState<Record<string, string>>({});
  const [currentRestaurantId, setCurrentRestaurantId] = useState(
    () => defaultRestaurants()[0]?.id ?? 'rp-9'
  );
  const dayScrollRef = useRef<ScrollView | null>(null);
  const didInitRestaurantRef = useRef(false);

  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const visibleDays = useMemo(
    () => getVisibleWeekDays(allWeekDays, weekIndex),
    [allWeekDays, weekIndex]
  );
  const selectedWeekMonday = String(weekMeta[weekIndex * 7]?.iso || '').slice(0, 10);

  useEffect(() => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedWeekMonday)) {
      setBorrowByEmpId({});
      return;
    }
    let cancelled = false;
    const mon = new Date(`${selectedWeekMonday}T12:00:00`);
    const bounds = getPayWeekBoundsForMonday(mon);
    void loadWeekExtrasSlice(bounds).then((slice) => {
      if (cancelled) return;
      const next: Record<string, string> = {};
      for (const e of employees) {
        const b = getEmployeeBorrowedRestaurantSync(e.id, slice);
        if (b) next[e.id] = b;
      }
      setBorrowByEmpId(next);
    });
    return () => {
      cancelled = true;
    };
  }, [selectedWeekMonday, employees, teamState?.updated_at]);

  /**
   * Team `usualRestaurant` plus pay-week borrow store (web employee switcher).
   * Main/primary store stays leftmost.
   */
  const restaurants = useMemo(() => {
    const borrowed = myEmployee?.id ? borrowByEmpId[myEmployee.id] : null;
    const visible = filterRestaurantsForEmployeeSchedule(
      allRestaurants,
      myEmployee?.usualRestaurant,
      borrowed
    );
    return orderRestaurantsMainFirst(visible, managerScheduleMainRestaurantId(myEmployee));
  }, [allRestaurants, myEmployee, borrowByEmpId]);

  useEffect(() => {
    if (!restaurants.length) return;
    if (!didInitRestaurantRef.current) {
      didInitRestaurantRef.current = true;
      const main = managerScheduleMainRestaurantId(myEmployee);
      if (main && restaurants.some((r) => r.id === main)) {
        setCurrentRestaurantId(main);
        return;
      }
    }
    if (restaurants.some((r) => r.id === currentRestaurantId)) return;
    const main = managerScheduleMainRestaurantId(myEmployee);
    const next =
      (main && restaurants.find((r) => r.id === main)?.id) || restaurants[0]?.id;
    if (next) setCurrentRestaurantId(next);
  }, [restaurants, currentRestaurantId, myEmployee]);

  useEffect(() => {
    const iso = String(params.weekMondayIso || '')
      .trim()
      .slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return;
    for (let w = 0; w < SCHEDULE_VIEW_WEEK_COUNT; w += 1) {
      if (weekMeta[w * 7]?.iso === iso) {
        setWeekIndex(w);
        break;
      }
    }
  }, [params.weekMondayIso, weekMeta]);

  const publishedMap = useMemo(() => {
    const map = normalizeSchedulePublishedMap(teamState?.schedule_published);
    seedDefaultPublishedWeeks(map, weekMeta);
    return map;
  }, [teamState?.schedule_published, weekMeta]);

  const weekPublished = isScheduleWeekIndexPublished(publishedMap, weekMeta, weekIndex);

  /** Derive store + rolled draft — avoid useEffect + setState layout thrash on every teamState tick. */
  const hydrated = useMemo(
    () =>
      hydrateScheduleAssignmentsFromTeamState(
        teamState?.schedule_assignments,
        allRestaurants,
        teamState?.draft_schedule
      ),
    [teamState?.schedule_assignments, teamState?.draft_schedule, allRestaurants]
  );
  const assignmentStore = hydrated.store;
  const draftScheduleRaw = hydrated.draftSchedule ?? teamState?.draft_schedule;
  const draftRows = useMemo(
    () => loadDraftFromTeamState(draftScheduleRaw, weekIndex, currentRestaurantId),
    [draftScheduleRaw, weekIndex, currentRestaurantId]
  );

  useEffect(() => {
    dayScrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [weekIndex, currentRestaurantId]);

  const lites = useMemo(
    () =>
      employees.map((e) => {
        const lite = toLite(e);
        lite.borrowedRestaurantId = borrowByEmpId[e.id] || null;
        return lite;
      }),
    [employees, borrowByEmpId]
  );

  const schedule = useMemo(() => {
    try {
      return buildSchedule({
        allWeekDays,
        draftScheduleRaw,
        employees: lites,
        restaurants: allRestaurants,
        currentRestaurantId,
        assignmentStore,
      });
    } catch (err) {
      console.warn('buildSchedule', err);
      return [] as ScheduleRow[];
    }
  }, [allWeekDays, draftScheduleRaw, lites, allRestaurants, currentRestaurantId, assignmentStore]);

  const otherStoreDayLabels = useMemo(() => {
    try {
      return buildOtherStoreDayLabelMap({
        visibleDays,
        weekIndex,
        draftScheduleRaw,
        draftRows,
        restaurants: allRestaurants,
        assignmentStore,
        currentRestaurantId,
      });
    } catch (err) {
      console.warn('buildOtherStoreDayLabelMap', err);
      return new Map<string, string>();
    }
  }, [
    visibleDays,
    weekIndex,
    draftScheduleRaw,
    draftRows,
    allRestaurants,
    assignmentStore,
    currentRestaurantId,
  ]);

  const calendarBody = useMemo(() => {
    try {
      return buildCalendarBody(
        schedule,
        visibleDays,
        draftRows,
        lites,
        currentRestaurantId,
        readSlotOrderByRestaurantForWeek(
          draftScheduleRaw,
          weekMeta[weekIndex * 7]?.iso || ''
        ),
        assignmentStore,
        weekIndex,
        otherStoreDayLabels
      );
    } catch (err) {
      console.warn('buildCalendarBody', err);
      return [] as CalendarBodyRow[];
    }
  }, [
    schedule,
    visibleDays,
    draftRows,
    lites,
    currentRestaurantId,
    draftScheduleRaw,
    weekMeta,
    weekIndex,
    assignmentStore,
    otherStoreDayLabels,
  ]);

  const daysWidth = visibleDays.length * CELL_MIN;

  const rowWeekTotals = useMemo(() => {
    const map = new Map<string, { hours: number; paidHours: number }>();
    for (const row of calendarBody) {
      if (row.kind !== 'cells') continue;
      map.set(
        `${row.role}:${row.trIdx}`,
        computeScheduleRowWeekTotals(schedule, row.role, row.trIdx, visibleDays)
      );
    }
    return map;
  }, [calendarBody, schedule, visibleDays]);

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <ScrollView
        style={styles.gridScroll}
        contentContainerStyle={styles.gridScrollContent}
        nestedScrollEnabled
        showsVerticalScrollIndicator
        keyboardShouldPersistTaps="handled"
      >
      <View style={styles.chrome}>
        <Text style={styles.hint}>{t('schedule.viewOnlyHint')}</Text>

        <View style={styles.toolbar}>
          <Text style={styles.toolbarLabel}>{t('common.week')}</Text>
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
          <Text style={styles.toolbarLabel}>{t('common.location')}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipsRow}>
            {restaurants.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => setCurrentRestaurantId(r.id)}
                style={[styles.chip, currentRestaurantId === r.id && styles.chipActive]}
              >
                <Text style={[styles.chipText, currentRestaurantId === r.id && styles.chipTextActive]}>
                  {r.name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>

        <View style={styles.legend}>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-bartender'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-bartender'].fg }]}>
                {staffTypeLabel('Bartender')}
              </Text>
            </View>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-kitchen'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-kitchen'].fg }]}>
                {staffTypeLabel('Kitchen')}
              </Text>
            </View>
            <View style={[styles.legendPill, { borderColor: ROLE_PILL['role-server'].border }]}>
              <Text style={[styles.legendTxt, { color: ROLE_PILL['role-server'].fg }]}>
                {staffTypeLabel('Server')}
              </Text>
            </View>
          </View>
      </View>

      {!weekPublished ? (
        <View style={styles.unpublished}>
          <Text style={styles.unpublishedTitle}>{t('schedule.notPublishedYet')}</Text>
          <Text style={styles.unpublishedBody}>
            {t('schedule.notPublishedBody', {
              range: formatScheduleWeekRangeLabel(weekMeta, weekIndex),
            })}
          </Text>
        </View>
      ) : (
        <>
          {loading && !teamState ? <Text style={styles.muted}>{t('schedule.loadingSchedule')}</Text> : null}

          <View style={styles.matrix}>
            <ScrollView
              ref={dayScrollRef}
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              keyboardShouldPersistTaps="handled"
            >
            <View style={styles.matrixInner}>
              <View style={[styles.personCol, { width: PERSON_COL }]}>
                <View style={styles.personTh}>
                  <Text style={styles.thFull}>{t('schedule.personHeader')}</Text>
                  <Text style={styles.thSub}>{t('schedule.rowAssignee')}</Text>
                </View>
                {calendarBody.map((row, ri) => (
                  <PersonColRow
                    key={`p-${ri}`}
                    row={row}
                    schedule={schedule}
                    visibleDays={visibleDays}
                    employees={lites}
                    restaurantId={currentRestaurantId}
                    assignmentStore={assignmentStore}
                    weekIndex={weekIndex}
                    unassignedLabel={t('common.unassigned')}
                    dayOffLabel={t('schedule.dayOffLabel')}
                  />
                ))}
              </View>

                <View style={{ width: daysWidth }}>
                  <View style={styles.headerDays}>
                    {visibleDays.map((dayStr) => {
                      const meta = weekMeta.find((m) => m.label === dayStr);
                      const parts = dayStr.split(' ');
                      const dow = parts[0] || '';
                      const rest = parts.slice(1).join(' ');
                      return (
                        <View key={dayStr} style={[styles.th, { width: CELL_MIN }]}>
                          <Text style={styles.thFull}>
                            {t(
                              (
                                {
                                  MONDAY: 'days.monday',
                                  TUESDAY: 'days.tuesday',
                                  WEDNESDAY: 'days.wednesday',
                                  THURSDAY: 'days.thursday',
                                  FRIDAY: 'days.friday',
                                  SATURDAY: 'days.saturday',
                                  SUNDAY: 'days.sunday',
                                } as Record<string, string>
                              )[meta?.dayNameUpper || dow.toUpperCase()] || 'days.monday'
                            )}
                          </Text>
                          <Text style={styles.thSub}>{rest}</Text>
                        </View>
                      );
                    })}
                  </View>
                  {calendarBody.map((row, ri) => (
                    <DayColRow key={`d-${ri}`} row={row} daysWidth={daysWidth} dayOffLabel={t('schedule.dayOffLabel')} />
                  ))}
                </View>
                <View style={[styles.sideTotals, { width: SIDE_TOTALS_W }]}>
                  <View style={styles.personTotalsTh}>
                    <Text style={styles.sideTotalsTitle}>{t('schedule.personTotals')}</Text>
                    <Text style={styles.thSub}>{t('schedule.personTotalsSub')}</Text>
                  </View>
                  {calendarBody.map((row, ri) => {
                    if (row.kind === 'section') {
                      return (
                        <View
                          key={`pt-s-${ri}`}
                          style={[
                            styles.personTotalsSection,
                            {
                              height: SECTION_ROW_H + SECTION_GAP_BELOW,
                              backgroundColor: sectionBg(row.variant),
                            },
                          ]}
                        />
                      );
                    }
                    const tot = rowWeekTotals.get(`${row.role}:${row.trIdx}`) || {
                      hours: 0,
                      paidHours: 0,
                    };
                    return (
                      <View key={`pt-${ri}`} style={styles.personTotalsCell}>
                        <Text style={styles.sideTotalsGross}>{formatScheduleDayHoursLabel(tot.hours)}</Text>
                        <Text style={styles.sideTotalsTag}>{t('schedule.dayGross')}</Text>
                        <Text style={styles.sideTotalsNet}>{formatScheduleDayHoursLabel(tot.paidHours)}</Text>
                        <Text style={styles.sideTotalsTag}>{t('schedule.dayAfterBreak')}</Text>
                      </View>
                    );
                  })}
                </View>
            </View>
            </ScrollView>
          </View>
        </>
      )}
      </ScrollView>
    </View>
  );
}

type PersonColRowProps = {
  row: CalendarBodyRow;
  schedule: ScheduleRow[];
  visibleDays: string[];
  employees: EmployeeLite[];
  restaurantId: string;
  assignmentStore?: AssignmentStore | null;
  weekIndex?: number;
  unassignedLabel: string;
  dayOffLabel: string;
};

const PersonColRow = memo(function PersonColRow({
  row,
  schedule,
  visibleDays,
  employees,
  restaurantId,
  assignmentStore,
  weekIndex,
  unassignedLabel,
}: PersonColRowProps) {
  const { t, staffTypeLabel } = useI18n();
  if (row.kind === 'section') {
    const bg = sectionBg(row.variant);
    const fg = sectionFg(row.variant);
    const sectionRole: RoleKey =
      row.variant === 'foh' ? 'Bartender' : row.variant === 'delivery' ? 'Server' : 'Kitchen';
    return (
      <View
        style={[
          styles.personSection,
          styles.sectionMatrixRow,
          { backgroundColor: bg, borderLeftColor: fg },
        ]}
      >
        <Text style={[styles.sectionText, { color: fg }]} numberOfLines={2}>
          {staffTypeLabel(sectionRole)}
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
    restaurantId,
    assignmentStore,
    weekIndex
  );
  const label = selected && selected !== 'Unassigned' ? selected : unassignedLabel;
  const selectedLite =
    selected && selected !== 'Unassigned'
      ? employees.find(
          (e) =>
            (e.displayName || `${e.firstName} ${e.lastName}`.trim()) === selected ||
            `${e.firstName} ${e.lastName}`.trim() === selected
        )
      : null;
  const awayPrimaryId =
    selectedLite?.primaryLocationId &&
    selectedLite.primaryLocationId !== restaurantId
      ? selectedLite.primaryLocationId
      : null;
  const awayPrimaryLabel = awayPrimaryId
    ? restaurantShortLabelForId(awayPrimaryId)
    : '';
  const borrowedFromId =
    !awayPrimaryLabel &&
    selectedLite?.borrowedRestaurantId === restaurantId &&
    selectedLite.usualRestaurant &&
    selectedLite.usualRestaurant !== 'both' &&
    selectedLite.usualRestaurant !== restaurantId
      ? selectedLite.usualRestaurant
      : null;
  const borrowedFromLabel = borrowedFromId
    ? borrowRestaurantShortLabel(borrowedFromId)
    : '';
  return (
    <View style={[styles.personCell, styles.dataMatrixRow]}>
      <View style={styles.personReadonly}>
        <Text style={styles.personSelectText} numberOfLines={2} ellipsizeMode="tail">
          {label}
        </Text>
        {awayPrimaryLabel ? (
          <Text style={styles.awayPrimaryBadge} numberOfLines={1}>
            {t('schedule.primaryStore', { store: awayPrimaryLabel })}
          </Text>
        ) : borrowedFromLabel ? (
          <Text style={styles.awayPrimaryBadge} numberOfLines={1}>
            {t('schedule.borrowedFrom', { store: borrowedFromLabel })}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

const DayColRow = memo(function DayColRow({
  row,
  daysWidth,
  dayOffLabel,
}: {
  row: CalendarBodyRow;
  daysWidth: number;
  dayOffLabel: string;
}) {
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
    <View style={[styles.dataDays, styles.dataMatrixRow, { width: daysWidth }]}>
      {row.cells.map((cell, ci) => (
        <View key={ci} style={[styles.cell, { width: CELL_MIN }]}>
          <CalendarCellView cell={cell} dayOffLabel={dayOffLabel} />
        </View>
      ))}
    </View>
  );
});

const CalendarCellView = memo(function CalendarCellView({
  cell,
  dayOffLabel,
}: {
  cell: CalendarCell;
  dayOffLabel: string;
}) {
  const { t } = useI18n();
  const otherStoreBadge = (label: string) => (
    <View style={styles.otherStorePill}>
      <Text style={styles.otherStorePillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
  if (cell.kind === 'empty') {
    const pill = pillForRole(cell.role);
    const body = cell.otherStoreLabel ? (
      otherStoreBadge(cell.otherStoreLabel)
    ) : (
      <Text style={styles.cellDayoffLabel}>{dayOffLabel}</Text>
    );
    return (
      <View
        style={[
          styles.cellInnerEmpty,
          {
            backgroundColor: pill.bg,
            borderColor: pill.border,
            borderLeftColor: pill.fg,
          },
        ]}
      >
        {body}
      </View>
    );
  }
  if (cell.kind === 'dayoff') {
    const pill = pillForRole(cell.role);
    return (
      <View
        style={[
          styles.cellInnerEmpty,
          styles.cellInnerEmptyTimed,
          {
            backgroundColor: pill.bg,
            borderColor: pill.border,
            borderLeftColor: pill.fg,
          },
        ]}
      >
        <View style={styles.dayoffTimeBlock}>
          <Text style={styles.cellTimeMuted} numberOfLines={1}>
            {cell.timeLabel}
          </Text>
        </View>
        {cell.otherStoreLabel ? (
          otherStoreBadge(cell.otherStoreLabel)
        ) : (
          <Text style={styles.cellDayoffLabel}>{dayOffLabel}</Text>
        )}
      </View>
    );
  }
  const pill = ROLE_PILL[cell.shift.roleClass] || ROLE_PILL['role-server'];
  const breakLabel = displayBreakAnnotation(cell.breakText || '', {
    noBreak: t('schedule.noBreak'),
    breakTime: t('schedule.breakTime'),
    office: t('schedule.office'),
  });
  return (
    <View
      style={[
        styles.cellInner,
        { borderColor: pill.border, backgroundColor: pill.bg, borderLeftColor: pill.fg },
      ]}
    >
      <Text style={styles.cellTime} numberOfLines={1}>
        {cell.timeLabel}
      </Text>
      {breakLabel ? (
        <Text style={styles.cellBreak} numberOfLines={1}>
          {breakLabel}
        </Text>
      ) : null}
      {cell.hours ? (
        <Text style={styles.cellHours} numberOfLines={1}>
          {cell.hours}
        </Text>
      ) : null}
      {cell.otherStoreLabel ? otherStoreBadge(cell.otherStoreLabel) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: '#f4f6f8' },
  chrome: { flexShrink: 0, backgroundColor: '#f4f6f8' },
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
  gridScroll: { flex: 1, minHeight: 0 },
  gridScrollContent: { flexGrow: 1, paddingBottom: 24 },
  matrix: { paddingHorizontal: 8, alignSelf: 'stretch', width: '100%' },
  matrixInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  personCol: {
    flexShrink: 0,
    backgroundColor: '#fff',
  },
  sideTotals: {
    flexShrink: 0,
    paddingHorizontal: 4,
    borderLeftWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  personTotalsTh: {
    height: HEADER_ROW_H,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'flex-end',
  },
  personTotalsSection: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  personTotalsCell: {
    height: DATA_ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 2,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f4',
  },
  sideTotalsTitle: { fontSize: 11, fontWeight: '800', color: '#0f172a' },
  sideTotalsGross: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  sideTotalsNet: { fontSize: 12, fontWeight: '600', color: '#334155' },
  sideTotalsTag: { fontSize: 9, color: '#64748b', marginBottom: 2 },
  personTh: {
    height: HEADER_ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
  },
  thFull: { fontSize: 11, fontWeight: '700', color: '#333' },
  thSub: { fontSize: 10, color: '#888', marginTop: 2 },
  sectionMatrixRow: {
    marginBottom: SECTION_GAP_BELOW,
  },
  personSection: {
    height: SECTION_ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderLeftWidth: 3,
  },
  sectionText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    textTransform: 'uppercase',
  },
  groupOrderSectionTitle: {
    color: '#334155',
  },
  groupOrderPersonLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
  },
  groupOrderDataRow: {
    backgroundColor: '#f8fafc',
  },
  groupOrderDataRowAlt: {
    backgroundColor: '#eef2f6',
  },
  groupOrderCell: {
    padding: 5,
    justifyContent: 'center',
    height: DATA_ROW_H,
  },
  groupOrderReadonly: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
    paddingVertical: 7,
    paddingHorizontal: 6,
  },
  dataMatrixRow: {
    height: DATA_ROW_H,
    borderBottomWidth: 1,
    borderBottomColor: '#f0f2f4',
    backgroundColor: '#fff',
  },
  personCell: {
    paddingHorizontal: 6,
    justifyContent: 'center',
  },
  personReadonly: {
    paddingVertical: 8,
    paddingHorizontal: 6,
    borderRadius: 6,
    backgroundColor: '#f8fafc',
  },
  personSelectText: { fontSize: 12, fontWeight: '600', color: '#111' },
  awayPrimaryBadge: {
    marginTop: 2,
    fontSize: 9,
    fontWeight: '700',
    color: '#64748b',
  },
  headerDays: { flexDirection: 'row', height: HEADER_ROW_H },
  th: {
    height: HEADER_ROW_H,
    justifyContent: 'center',
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
    backgroundColor: '#fff',
  },
  sectionDayFill: {
    height: SECTION_ROW_H,
  },
  dataDays: {
    flexDirection: 'row',
    height: DATA_ROW_H,
    alignItems: 'stretch',
  },
  cell: {
    height: DATA_ROW_H,
    borderRightWidth: 1,
    borderRightColor: '#f0f2f4',
    padding: 4,
  },
  cellInner: {
    flex: 1,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
    overflow: 'hidden',
  },
  cellInnerEmpty: {
    flex: 1,
    justifyContent: 'center',
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  cellInnerEmptyTimed: {
    justifyContent: 'flex-start',
  },
  cellTime: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  cellTimeMuted: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  dayoffTimeBlock: {
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#cbd5e1',
  },
  cellDayoffLabel: { fontSize: 10, color: '#64748b', marginTop: 4, fontWeight: '700' },
  otherStorePill: {
    marginTop: 4,
    paddingVertical: 1,
    paddingHorizontal: 5,
    borderRadius: 4,
    backgroundColor: '#ffedd5',
    borderWidth: 1,
    borderColor: '#fdba74',
    alignSelf: 'stretch',
  },
  otherStorePillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#9a3412',
    textAlign: 'center',
  },
  cellBreak: { fontSize: 10, color: '#64748b', marginTop: 2 },
  cellHours: { fontSize: 10, color: '#334155', marginTop: 2, fontWeight: '600' },
});
