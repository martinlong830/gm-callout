import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  InteractionManager,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, type ErrorBoundaryProps } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  employeeDisplayName,
  employeePrimaryLocationId,
  normalizeEmployeeStaffType,
  managerCanEditRestaurant,
  managerManagedRestaurantId,
  managerScheduleMainRestaurantId,
  orderRestaurantsMainFirst,
  type EmployeeRow,
} from '../../lib/employees';
import { readStoredTeamStateId } from '../../lib/companySession';
import { useI18n } from '../../contexts/LocaleContext';
import { portalNotifySchedulePublished } from '../../lib/portalAuth';
import { isManagerLikeRole } from '../../lib/roles';
import { formatScheduleWeekRangeLabel } from '../../lib/schedule/employeeShiftDisplay';
import {
  fetchScheduleRevision,
  formatScheduleRevisionLabel,
  hashScheduleBundle,
  insertScheduleRevision,
  listScheduleRevisions,
  type ScheduleRevisionRow,
} from '../../lib/schedule/scheduleRevisions';
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
  addDraftSlotRow,
  applyShiftSlotEdit,
  assignPersonToScheduleRow,
  breakAnnotationTimeToHHMM,
  BREAK_ANNOTATION_TYPE_PRESETS,
  buildAllWeekDayLabels,
  buildCalendarBody,
  buildOtherStoreDayLabelMap,
  buildSchedule,
  buildWeeksFromMonday,
  compactAssignmentsAfterDraftSlotDeletes,
  computeScheduleRowWeekTotals,
  defaultRestaurants,
  defaultTimesForDraftCell,
  deleteDraftSlotRow,
  draftSlotRowHasContent,
  formatBreakAnnotation,
  getScheduleAnchorMondayDate,
  getVisibleWeekDays,
  hydrateScheduleAssignmentsFromTeamState,
  isScheduleWeekPublished,
  loadDraftFromTeamState,
  namesForScheduleRowPersonPicker,
  namesForScheduleBorrowPersonPicker,
  SCHEDULE_BORROW_PERSON_VALUE,
  normalizeBreakAnnotationTime,
  normalizeSchedulePublishedMap,
  OFFICE_BREAK_TIME_PRESETS,
  OFFICE_DEFAULT_BREAK_TIME,
  OFFICE_DEFAULT_START_HHMM,
  orderedScheduleSlotIndicesForRole,
  parseBreakAnnotation,
  displayBreakAnnotation,
  patchDraftScheduleForWeek,
  purgeDefaultUnassignedRestaurantAssignments,
  redPokeShiftHoursDecimal,
  formatScheduleDayHoursLabel,
  restoreFohTemplateWeekBreaks,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  schedulePublishedPayload,
  scheduleRowPrimaryPerson,
  seedDefaultPublishedWeeks,
  SHIFT_DETAIL_BREAK_TIME_PRESETS,
  slotCountForRole,
  slotCountForRoleWithAssignments,
  STAFF_TYPE_LABELS,
  assignmentShell,
  WEEKDAY_KEYS,
  weekdayKeyFromScheduleDay,
  type BreakAnnotationType,
  type CalendarBodyRow,
  type CalendarCell,
} from '../../lib/schedule/engine';
import { getPayWeekBoundsForMonday } from '../../lib/timecards/payWeek';
import { restaurantShortLabelForId } from '../../lib/timecards/restaurantAttribution';
import { loadWeekExtrasSlice } from '../../lib/timecards/weekExtras';
import {
  getEmployeeBorrowedRestaurantSync,
  restaurantShortLabel as borrowRestaurantShortLabel,
  employeeEligibleForWeekBorrow,
  setEmployeeBorrowedRestaurant,
  type BorrowRestaurantId,
} from '../../lib/timecards/weekBorrow';
import {
  getCustomSlotOrderForRole,
  mergePendingDraftWithHydrated,
  moveTrIdxInSlotOrder,
  patchSlotOrderAfterAdd,
  patchSlotOrderAfterDelete,
  patchSlotOrderInDraftSchedule,
  readSlotOrderByRestaurantForWeek,
} from '../../lib/schedule/slotOrder';
import {
  getGroupOrderPotentialCell,
  GROUP_ORDER_POTENTIAL_PLATFORMS,
  patchGroupOrderPotentialInDraft,
} from '../../lib/schedule/groupOrderPotential';

/** Wide enough for a single-line slot time (e.g. 10:00 AM – 7:30 PM) in the cell header. */
const CELL_MIN = 158;
/** Sticky Person column — parity with web `.calendar-row-person-col`. */
const PERSON_COL = 132;
/** Right-rail per-person week hours (scrolls with days). */
const SIDE_TOTALS_W = 68;
/**
 * Fixed height for role section bars (person sticky + day fill).
 * Same parent row owns both sides — height cannot diverge.
 */
const SECTION_ROW_H = 52;
/** Gap between role bar and first shift row — keeps bars visually separate from cells. */
const SECTION_GAP_BELOW = 8;
/** Shared header height so PERSON sticky and day headers stay level. */
const HEADER_ROW_H = 52;
/** Minimum data-row height (person + day cells share one row View). */
const DATA_ROW_MIN_H = 96;
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

function liteByScheduleName(employees: EmployeeLite[], name: string): EmployeeLite | undefined {
  if (!name || name === 'Unassigned') return undefined;
  return employees.find(
    (e) =>
      (e.displayName || `${e.firstName} ${e.lastName}`.trim()) === name ||
      `${e.firstName} ${e.lastName}`.trim() === name
  );
}

function borrowHomeMeta(
  emp: EmployeeLite | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string
): string {
  if (!emp) return '';
  const home = emp.usualRestaurant || 'both';
  if (home === 'both') return t('schedule.borrowHomeBoth');
  return t('schedule.borrowHomeStore', { store: restaurantShortLabelForId(home) });
}

type RowPersonTarget = { role: RoleKey; trIdx: number };
type ShiftEditTarget = {
  role: RoleKey;
  trIdx: number;
  dayStr: string;
  shift?: ScheduleRow;
};
type ScheduleUndoSnap = {
  assignmentStore: AssignmentStore;
  draftScheduleRaw: unknown;
};

const SCHEDULE_UNDO_MAX = 40;
const PERSIST_DEBOUNCE_MS = 3000;
const PERSIST_RETRY_MS = 5000;

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: (normalizeEmployeeStaffType(e.staffType) || e.staffType) as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
    hourlyRate: e.hourlyRate,
    primaryLocationId: employeePrimaryLocationId(e),
    meta: e.meta,
  };
}

type CopyTimesClip = {
  start: string;
  end: string;
  breakType: BreakAnnotationType;
  breakTimeLabel: string;
};

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

/** Keep schedule tab usable if a render throw escapes (admin cold-starts here). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function ManagerScheduleScreen() {
  const insets = useSafeAreaInsets();
  const { role, session } = useAuth();
  const { t, staffTypeLabel } = useI18n();
  const { employees, teamState, refetch, loading, applyLocalScheduleAssignments, myEmployee, setSchedulePushInFlight, noteLocalSchedulePush } = useAppData();
  const params = useLocalSearchParams<{ weekMondayIso?: string }>();
  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const [restaurants] = useState<Restaurant[]>(() => defaultRestaurants());
  /** Main store leftmost; does not reshuffle when the selected chip changes. */
  const scheduleRestaurants = useMemo(
    () => orderRestaurantsMainFirst(restaurants, managerScheduleMainRestaurantId(myEmployee)),
    [restaurants, myEmployee]
  );
  const [currentRestaurantId, setCurrentRestaurantId] = useState(restaurants[0]?.id ?? 'rp-9');
  const scheduleEditable = managerCanEditRestaurant(myEmployee, currentRestaurantId, role);

  useEffect(() => {
    const main = managerScheduleMainRestaurantId(myEmployee);
    if (main !== 'rp-8' && main !== 'rp-9') return;
    const scope = managerManagedRestaurantId(myEmployee, role);
    /* Store-scoped: always land on managed store. Company-wide / admin: prefer primary when set. */
    if (scope === main || scope == null) {
      setCurrentRestaurantId(main);
    }
  }, [myEmployee, role]);
  const [assignmentStore, setAssignmentStore] = useState<AssignmentStore>(() =>
    assignmentShell(restaurants)
  );
  const [rolledDraftRaw, setRolledDraftRaw] = useState<unknown>(null);
  const [shiftEditor, setShiftEditor] = useState<ShiftEditTarget | null>(null);
  const [editDayOff, setEditDayOff] = useState(false);
  const [editStart, setEditStart] = useState('10:00');
  const [editEnd, setEditEnd] = useState('18:00');
  const [editBreakType, setEditBreakType] = useState<BreakAnnotationType>('BREAK TIME');
  const [editBreakTime, setEditBreakTime] = useState('15:00');
  const [editWorker, setEditWorker] = useState('Unassigned');
  const [shiftPersonBorrowMode, setShiftPersonBorrowMode] = useState(false);
  const [copyTimesClip, setCopyTimesClip] = useState<CopyTimesClip | null>(null);
  const [rowPersonPicker, setRowPersonPicker] = useState<RowPersonTarget | null>(null);
  const [rowPersonBorrowMode, setRowPersonBorrowMode] = useState(false);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRows, setHistoryRows] = useState<ScheduleRevisionRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyBusyId, setHistoryBusyId] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keeps a pending draft payload across debounced assignment saves (e.g. Monday window roll). */
  const pendingDraftRef = useRef<unknown>(undefined);
  const pendingStoreRef = useRef<AssignmentStore | null>(null);
  /** True from a manager edit until its save is confirmed — hydrate must not overwrite it. */
  const localEditPendingRef = useRef(false);
  const persistCloudRef = useRef<
    ((store: AssignmentStore, draftSchedule?: unknown) => Promise<void>) | null
  >(null);
  const undoStackRef = useRef<ScheduleUndoSnap[]>([]);
  /** Skip clearing undo when hydrate re-enters after a local teamState write. */
  const suppressHydrateUndoClearRef = useRef(false);
  const assignmentStoreRef = useRef(assignmentStore);
  const draftScheduleRawRef = useRef<unknown>(null);

  /** Single horizontal ScrollView for all day columns — Person column stays outside. */
  const dayScrollRef = useRef<ScrollView | null>(null);
  const outerScrollRef = useRef<ScrollView | null>(null);
  const scheduleScrollRestoreRef = useRef<{ y: number; x: number } | null>(null);
  const outerScrollYRef = useRef(0);
  const dayScrollXRef = useRef(0);

  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const visibleDays = useMemo(
    () => getVisibleWeekDays(allWeekDays, weekIndex),
    [allWeekDays, weekIndex]
  );

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

  const selectedWeekMonday = weekMeta[weekIndex * 7]?.iso || '';
  const selectedWeekPublished = !!(
    selectedWeekMonday && isScheduleWeekPublished(publishedMap, selectedWeekMonday)
  );
  const selectedWeekIsPast = weekIndex < SCHEDULE_TEMPLATE_WEEK_INDEX;
  const selectedWeekRange = formatScheduleWeekRangeLabel(weekMeta, weekIndex);

  const publishSelectedWeek = useCallback(() => {
    if (!selectedWeekMonday || !isManagerLikeRole(role) || selectedWeekIsPast) return;
    if (!managerCanEditRestaurant(myEmployee, currentRestaurantId, role)) {
      Alert.alert(t('schedule.viewOnlyOtherStore'), t('schedule.viewOnlyOtherStoreHint'));
      return;
    }
    const runPublish = (audience: 'admins' | 'employees') => {
      void (async () => {
        if (!supabase) return;
        setPublishing(true);
        try {
          const map = { ...publishedMap, [selectedWeekMonday]: true as const };
          const payload = schedulePublishedPayload(map);
          const teamStateId = await readStoredTeamStateId();
          const up = await supabase.from('team_state').upsert(
            { id: teamStateId, schedule_published: payload },
            { onConflict: 'id' }
          );
          if (up.error) {
            Alert.alert(t('schedule.publishFailed'), up.error.message || t('schedule.couldNotSavePublish'));
            return;
          }
          await broadcastTeamStateChanged(
            supabase,
            teamStateId,
            ['schedule_published'],
            session?.user?.id
          );
          /* Snapshot publish in revision history (matches web). */
          void insertScheduleRevision(supabase, {
            teamStateId,
            userId: session?.user?.id,
            source: 'publish',
            assignments: assignmentStoreRef.current,
            draft: draftScheduleRawRef.current ?? {},
            published: payload,
            dedupe: false,
          });
          const notify = await portalNotifySchedulePublished({
            weekMondayIso: selectedWeekMonday,
            weekRangeLabel: selectedWeekRange,
            teamStateId,
            audience,
            restaurantId: currentRestaurantId,
          });
          await refetch({ silent: true });
          if (!notify.ok) {
            Alert.alert(
              t('schedule.published'),
              t('schedule.publishedNotifyFailed', { range: selectedWeekRange, message: notify.message })
            );
          } else if (notify.sent > 0) {
            const failNote =
              notify.failed && notify.failed > 0
                ? ` ${notify.failed} failed${notify.message ? ` (${notify.message})` : ''}.`
                : '';
            const inAppNote =
              notify.inAppCreated && notify.inAppCreated > 0
                ? ` In-app notifications: ${notify.inAppCreated}.`
                : '';
            Alert.alert(
              t('schedule.published'),
              t('schedule.publishedNotified', {
                count: notify.sent,
                s: notify.sent === 1 ? '' : 's',
              }) +
                failNote +
                inAppNote
            );
          } else {
            Alert.alert(
              t('schedule.published'),
              notify.message ||
                t('schedule.publishedNoPush', { range: selectedWeekRange })
            );
          }
        } finally {
          setPublishing(false);
        }
      })();
    };

    const msg = selectedWeekPublished
      ? t('schedule.publishConfirmNotify', { range: selectedWeekRange })
      : t('schedule.publishConfirmPublish', { range: selectedWeekRange });
    Alert.alert(t('schedule.publishNotify'), msg, [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('schedule.publishNotifyAdmins'),
        onPress: () => runPublish('admins'),
      },
      {
        text: t('schedule.publishNotifyEmployees'),
        onPress: () => runPublish('employees'),
      },
    ]);
  }, [
    publishedMap,
    refetch,
    role,
    selectedWeekIsPast,
    selectedWeekMonday,
    selectedWeekPublished,
    selectedWeekRange,
    session?.user?.id,
    myEmployee,
    currentRestaurantId,
    t,
  ]);

  const draftScheduleRaw = rolledDraftRaw ?? teamState?.draft_schedule;
  assignmentStoreRef.current = assignmentStore;
  draftScheduleRawRef.current = draftScheduleRaw;
  const draftRows = useMemo(
    () => loadDraftFromTeamState(draftScheduleRaw, weekIndex, currentRestaurantId),
    [draftScheduleRaw, weekIndex, currentRestaurantId]
  );

  const slotOrderByRestaurant = useMemo(
    () => readSlotOrderByRestaurantForWeek(draftScheduleRaw, selectedWeekMonday),
    [draftScheduleRaw, selectedWeekMonday]
  );

  useEffect(() => {
    dayScrollRef.current?.scrollTo({ x: 0, animated: false });
  }, [weekIndex, currentRestaurantId]);

  useEffect(() => {
    undoStackRef.current = [];
    setUndoDepth(0);
  }, [weekIndex, currentRestaurantId]);

  const clearUndoStack = useCallback(() => {
    if (!undoStackRef.current.length) return;
    undoStackRef.current = [];
    setUndoDepth(0);
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    if (!isManagerLikeRole(role)) return;
    const snap: ScheduleUndoSnap = {
      assignmentStore: JSON.parse(JSON.stringify(assignmentStoreRef.current)) as AssignmentStore,
      draftScheduleRaw:
        draftScheduleRawRef.current != null
          ? JSON.parse(JSON.stringify(draftScheduleRawRef.current))
          : null,
    };
    const top = undoStackRef.current[undoStackRef.current.length - 1];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
    const next = undoStackRef.current.concat(snap);
    if (next.length > SCHEDULE_UNDO_MAX) next.splice(0, next.length - SCHEDULE_UNDO_MAX);
    undoStackRef.current = next;
    setUndoDepth(next.length);
  }, [role]);

  /** Re-arm the debounced save; the timer always flushes the latest pending store. */
  const armSaveTimer = useCallback((delayMs: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null;
      const latestStore = pendingStoreRef.current;
      if (!latestStore) return;
      void persistCloudRef.current?.(latestStore, pendingDraftRef.current);
    }, delayMs);
  }, []);

  const persistCloud = useCallback(
    async (store: AssignmentStore, draftSchedule?: unknown) => {
      if (!supabase || !isManagerLikeRole(role)) return;
      setSaving(true);
      setSchedulePushInFlight(true);
      try {
        const toSave = JSON.parse(JSON.stringify(store)) as AssignmentStore;
        purgeDefaultUnassignedRestaurantAssignments(toSave, restaurants);
        const teamStateId = await readStoredTeamStateId();
        const draftToSave =
          draftSchedule !== undefined ? draftSchedule : pendingDraftRef.current;
        const pushedAssignJson = JSON.stringify(toSave);
        const pushedDraftJson =
          draftToSave !== undefined ? JSON.stringify(draftToSave) : null;
        const payload: Record<string, unknown> = {
          id: teamStateId,
          schedule_assignments: toSave,
        };
        const fields = ['schedule_assignments'];
        if (draftToSave !== undefined) {
          payload.draft_schedule = draftToSave;
          fields.push('draft_schedule');
        }
        const up = await supabase
          .from('team_state')
          .upsert(payload, { onConflict: 'id' })
          .select('id, updated_at')
          .single();
        if (up.error) {
          console.warn('team_state upsert', up.error);
          /* Stays dirty so remote cannot win; retry or the edit is lost on the next fetch. */
          armSaveTimer(PERSIST_RETRY_MS);
        } else {
          const pushedUpdatedAt =
            up.data?.updated_at != null ? String(up.data.updated_at) : undefined;
          const draftForHash =
            draftToSave !== undefined
              ? draftToSave
              : draftScheduleRawRef.current ?? teamState?.draft_schedule ?? {};
          const pushHash = hashScheduleBundle(toSave, draftForHash);
          noteLocalSchedulePush({ hash: pushHash, updatedAt: pushedUpdatedAt });
          await broadcastTeamStateChanged(
            supabase,
            teamStateId,
            fields,
            session?.user?.id
          );
          /*
           * Only clear dirty/pending when local SoT still matches what we just pushed.
           * An edit during the upsert must keep dirty=true and re-arm the timer —
           * otherwise a remote echo of the older snapshot rolls assignments back.
           */
          const liveStore = pendingStoreRef.current ?? toSave;
          const liveDraft =
            pendingDraftRef.current !== undefined ? pendingDraftRef.current : draftToSave;
          const assignStillDirty = JSON.stringify(liveStore) !== pushedAssignJson;
          const draftStillDirty =
            pushedDraftJson != null && JSON.stringify(liveDraft ?? null) !== pushedDraftJson;
          suppressHydrateUndoClearRef.current = true;
          if (assignStillDirty || draftStillDirty) {
            localEditPendingRef.current = true;
            if (!pendingStoreRef.current) pendingStoreRef.current = liveStore;
            if (
              draftStillDirty &&
              pendingDraftRef.current === undefined &&
              liveDraft !== undefined
            ) {
              pendingDraftRef.current = liveDraft;
            }
            applyLocalScheduleAssignments(liveStore, liveDraft, {
              markDirty: true,
              pushedUpdatedAt,
            });
            armSaveTimer(100);
          } else {
            pendingDraftRef.current = undefined;
            pendingStoreRef.current = null;
            localEditPendingRef.current = false;
            applyLocalScheduleAssignments(toSave, draftToSave, {
              markDirty: false,
              pushedUpdatedAt,
            });
            /* Always snapshot after a clean sync (assignments and/or draft) — matches web. */
            void insertScheduleRevision(supabase, {
              teamStateId,
              userId: session?.user?.id,
              source: 'persist',
              assignments: toSave,
              draft:
                draftToSave !== undefined
                  ? draftToSave
                  : draftScheduleRawRef.current ?? teamState?.draft_schedule ?? {},
              published: teamState?.schedule_published ?? null,
            });
          }
        }
      } finally {
        setSchedulePushInFlight(false);
        setSaving(false);
      }
    },
    [
      role,
      restaurants,
      session?.user?.id,
      teamState?.draft_schedule,
      teamState?.schedule_published,
      applyLocalScheduleAssignments,
      armSaveTimer,
      setSchedulePushInFlight,
      noteLocalSchedulePush,
    ]
  );

  useEffect(() => {
    persistCloudRef.current = persistCloud;
  }, [persistCloud]);

  /* Leaving the screen inside the debounce window must still save the edit. */
  useEffect(
    () => () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      const latestStore = pendingStoreRef.current;
      if (latestStore) void persistCloudRef.current?.(latestStore, pendingDraftRef.current);
    },
    []
  );

  const queuePersist = useCallback(
    (store: AssignmentStore, draftSchedule?: unknown, opts?: { fromHydrate?: boolean }) => {
      pendingStoreRef.current = store;
      /* Hydrate-driven saves must not masquerade as manager edits (see hydrate effect). */
      if (!opts?.fromHydrate) localEditPendingRef.current = true;
      if (draftSchedule !== undefined) {
        pendingDraftRef.current = draftSchedule;
      } else if (pendingDraftRef.current === undefined) {
        /*
         * Person-only edits used to leave pendingDraft empty, so hydrate could paint a
         * stale remote draft (times/rows) over the live grid while assignments stayed local.
         */
        const liveDraft = draftScheduleRawRef.current;
        if (liveDraft != null) pendingDraftRef.current = liveDraft;
      }
      armSaveTimer(PERSIST_DEBOUNCE_MS);
    },
    [armSaveTimer]
  );

  const undoLastChange = useCallback(() => {
    const snap = undoStackRef.current.pop();
    if (!snap) return;
    setUndoDepth(undoStackRef.current.length);
    suppressHydrateUndoClearRef.current = true;
    setAssignmentStore(snap.assignmentStore);
    setRolledDraftRaw(snap.draftScheduleRaw);
    applyLocalScheduleAssignments(snap.assignmentStore, snap.draftScheduleRaw);
    queuePersist(snap.assignmentStore, snap.draftScheduleRaw);
  }, [applyLocalScheduleAssignments, queuePersist]);

  const openScheduleHistory = useCallback(async () => {
    const sb = supabase;
    if (!sb || !isManagerLikeRole(role)) return;
    setHistoryOpen(true);
    setHistoryLoading(true);
    try {
      const teamStateId = await readStoredTeamStateId();
      const res = await listScheduleRevisions(sb, teamStateId, 40);
      if (!res.ok) {
        Alert.alert(t('schedule.historyFailed'), res.error || t('schedule.couldNotSave'));
        setHistoryRows([]);
        return;
      }
      setHistoryRows(res.rows);
    } finally {
      setHistoryLoading(false);
    }
  }, [role, t]);

  const hardRevertToRevision = useCallback(
    (revisionId: string) => {
      if (!supabase || !isManagerLikeRole(role) || !scheduleEditable) return;
      Alert.alert(t('schedule.hardRevertTitle'), t('schedule.hardRevertBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('schedule.hardRevertConfirm'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const sb = supabase;
              if (!sb) return;
              setHistoryBusyId(revisionId);
              try {
                const teamStateId = await readStoredTeamStateId();
                const curAssign = assignmentStoreRef.current;
                const curDraft = draftScheduleRawRef.current ?? teamState?.draft_schedule ?? {};
                await insertScheduleRevision(sb, {
                  teamStateId,
                  userId: session?.user?.id,
                  source: 'pre_revert',
                  assignments: curAssign,
                  draft: curDraft,
                  published: teamState?.schedule_published ?? null,
                  label: formatScheduleRevisionLabel('pre_revert'),
                  dedupe: false,
                });
                const fetched = await fetchScheduleRevision(sb, revisionId);
                if (!fetched.ok || !fetched.row) {
                  Alert.alert(t('schedule.historyFailed'), fetched.error || t('schedule.couldNotSave'));
                  return;
                }
                const nextAssign = (fetched.row.schedule_assignments || {}) as AssignmentStore;
                const nextDraft = fetched.row.draft_schedule ?? {};
                pushUndoSnapshot();
                suppressHydrateUndoClearRef.current = true;
                setAssignmentStore(nextAssign);
                setRolledDraftRaw(nextDraft);
                applyLocalScheduleAssignments(nextAssign, nextDraft, { markDirty: true });
                pendingStoreRef.current = nextAssign;
                pendingDraftRef.current = nextDraft;
                localEditPendingRef.current = true;
                /* Match web: restore assignments + draft only; leave published weeks as-is. */
                await persistCloud(nextAssign, nextDraft);
                await insertScheduleRevision(sb, {
                  teamStateId,
                  userId: session?.user?.id,
                  source: 'hard_revert',
                  assignments: nextAssign,
                  draft: nextDraft,
                  published: teamState?.schedule_published ?? null,
                  dedupe: false,
                });
                setHistoryOpen(false);
                Alert.alert(t('schedule.hardRevertDone'), t('schedule.hardRevertDoneBody'));
                await refetch({ silent: true });
              } finally {
                setHistoryBusyId(null);
              }
            })();
          },
        },
      ]);
    },
    [
      role,
      scheduleEditable,
      t,
      session?.user?.id,
      teamState?.draft_schedule,
      teamState?.schedule_published,
      applyLocalScheduleAssignments,
      pushUndoSnapshot,
      persistCloud,
    ]
  );

  useEffect(() => {
    const pendingDraft = pendingDraftRef.current;
    const pendingStore = pendingStoreRef.current;
    const editPending = localEditPendingRef.current || !!pendingStore;
    const rolled = hydrateScheduleAssignmentsFromTeamState(
      teamState?.schedule_assignments,
      restaurants,
      teamState?.draft_schedule
    );
    let draftOut: unknown = rolled.draftSchedule ?? teamState?.draft_schedule ?? null;
    /*
     * Debounced saves leave a window where remote/echo hydrate can arrive with a stale
     * draft_schedule (missing the reorder). Keep pending slotOrderByWeek as SoT until flush.
     */
    if (pendingDraft !== undefined) {
      draftOut = mergePendingDraftWithHydrated(pendingDraft, draftOut);
      pendingDraftRef.current = draftOut;
    }
    /*
     * While a manager edit is waiting to save, never paint remote/cache assignments over
     * the local store — that is the main flash/revert path after person or time edits.
     */
    if (editPending) {
      if (pendingStore) setAssignmentStore(pendingStore);
      setRolledDraftRaw(draftOut);
      suppressHydrateUndoClearRef.current = false;
      return;
    }
    let nextStore = rolled.store;
    let fohChanged = false;
    if (isManagerLikeRole(role) && scheduleEditable) {
      const foh = restoreFohTemplateWeekBreaks(
        nextStore,
        employees.map(toLite),
        currentRestaurantId,
        SCHEDULE_TEMPLATE_WEEK_INDEX
      );
      if (foh.changed) {
        nextStore = foh.store;
        fohChanged = true;
      }
    }
    setAssignmentStore(nextStore);
    setRolledDraftRaw(draftOut);
    if ((rolled.changed || fohChanged) && isManagerLikeRole(role)) {
      /* Local commits (incl. delete-slot) update teamState and re-enter here — do not wipe Undo. */
      if (!suppressHydrateUndoClearRef.current) clearUndoStack();
      applyLocalScheduleAssignments(nextStore, draftOut, {
        markDirty: fohChanged ? true : 'keep',
      });
      queuePersist(nextStore, draftOut, { fromHydrate: !fohChanged });
    } else if (rolled.draftMetaChanged && isManagerLikeRole(role)) {
      /* Seed bookkeeping only — keep it in the local cache, never spend a cloud write on it. */
      applyLocalScheduleAssignments(nextStore, draftOut, { markDirty: 'keep' });
    }
    suppressHydrateUndoClearRef.current = false;
  }, [
    teamState,
    restaurants,
    role,
    scheduleEditable,
    currentRestaurantId,
    employees,
    queuePersist,
    applyLocalScheduleAssignments,
    clearUndoStack,
  ]);

  const [borrowByEmpId, setBorrowByEmpId] = useState<Record<string, string>>({});

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
        restaurants,
        currentRestaurantId,
        assignmentStore,
      });
    } catch (err) {
      console.warn('buildSchedule', err);
      return [] as ScheduleRow[];
    }
  }, [allWeekDays, draftScheduleRaw, lites, restaurants, currentRestaurantId, assignmentStore]);

  const otherStoreDayLabels = useMemo(() => {
    try {
      return buildOtherStoreDayLabelMap({
        visibleDays,
        weekIndex,
        draftScheduleRaw,
        draftRows,
        restaurants,
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
    restaurants,
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
        slotOrderByRestaurant,
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
    slotOrderByRestaurant,
    assignmentStore,
    weekIndex,
    otherStoreDayLabels,
  ]);

  /** Display position within role section → enable ↑/↓. */
  const slotMoveFlags = useMemo(() => {
    const flags = new Map<string, { up: boolean; down: boolean }>();
    (['Bartender', 'Kitchen', 'Server'] as RoleKey[]).forEach((roleKey) => {
      const slotN = slotCountForRoleWithAssignments(
        draftRows,
        roleKey,
        assignmentStore,
        currentRestaurantId,
        weekIndex
      );
      const order = orderedScheduleSlotIndicesForRole(
        schedule,
        roleKey,
        slotN,
        visibleDays,
        lites,
        currentRestaurantId,
        slotOrderByRestaurant,
        assignmentStore,
        weekIndex
      );
      order.forEach((trIdx, pos) => {
        flags.set(`${roleKey}:${trIdx}`, {
          up: pos > 0,
          down: pos < order.length - 1,
        });
      });
    });
    return flags;
  }, [
    schedule,
    draftRows,
    visibleDays,
    lites,
    currentRestaurantId,
    slotOrderByRestaurant,
    assignmentStore,
    weekIndex,
  ]);

  const daysWidth = visibleDays.length * CELL_MIN;

  function captureScheduleScroll() {
    scheduleScrollRestoreRef.current = {
      y: outerScrollYRef.current,
      x: dayScrollXRef.current,
    };
  }

  function restoreScheduleScroll() {
    const saved = scheduleScrollRestoreRef.current;
    scheduleScrollRestoreRef.current = null;
    if (!saved) return;
    const apply = () => {
      outerScrollRef.current?.scrollTo({ y: saved.y, animated: false });
      dayScrollRef.current?.scrollTo({ x: saved.x, animated: false });
    };
    requestAnimationFrame(() => {
      apply();
      InteractionManager.runAfterInteractions(() => {
        requestAnimationFrame(apply);
      });
    });
  }

  function breakTimePresetsForType(
    breakType: BreakAnnotationType,
    currentLabel?: string
  ): string[] {
    const base =
      breakType === 'OFFICE' ? OFFICE_BREAK_TIME_PRESETS : SHIFT_DETAIL_BREAK_TIME_PRESETS;
    const norm = normalizeBreakAnnotationTime(currentLabel || '') || '';
    /* Keep web draft-modal times (11:00AM–7:00PM) selectable so open/save does not rewrite them. */
    if (norm && breakType !== 'NO BREAK' && base.indexOf(norm) < 0) {
      return [...base, norm];
    }
    return base;
  }

  function clampBreakTimeLabel(breakType: BreakAnnotationType, label: string): string {
    const norm = normalizeBreakAnnotationTime(label) || '';
    if (norm) return norm;
    return breakType === 'OFFICE' ? OFFICE_DEFAULT_BREAK_TIME : '3:00PM';
  }

  function applyBreakTypeChange(breakType: BreakAnnotationType) {
    setEditBreakType(breakType);
    if (breakType === 'OFFICE') {
      setEditStart(OFFICE_DEFAULT_START_HHMM);
      setEditBreakTime(breakAnnotationTimeToHHMM(OFFICE_DEFAULT_BREAK_TIME) || '14:00');
      return;
    }
    if (breakType === 'NO BREAK') return;
    const nextLabel = clampBreakTimeLabel('BREAK TIME', normalizeBreakAnnotationTime(editBreakTime) || '3:00PM');
    setEditBreakTime(breakAnnotationTimeToHHMM(nextLabel) || '15:00');
  }

  function persistSlotEdit(opts: {
    role: RoleKey;
    trIdx: number;
    dayStr: string;
    start: string;
    end: string;
    isDayOff: boolean;
    breakText: string | null;
    workers?: string[] | null;
  }): boolean {
    const wk = weekdayKeyFromScheduleDay(opts.dayStr);
    const di = WEEKDAY_KEYS.indexOf(wk);
    if (di < 0) return false;
    const applied = applyShiftSlotEdit({
      draftRows,
      store: assignmentStoreRef.current,
      restaurantId: currentRestaurantId,
      weekIndex,
      role: opts.role,
      trIdx: opts.trIdx,
      dayInWeek: di,
      start: opts.start,
      end: opts.end,
      isDayOff: opts.isDayOff,
      breakText: opts.breakText,
      workers: opts.workers,
    });
    if (!applied) return false;
    pushUndoSnapshot();
    const draftPayload = patchDraftScheduleForWeek(
      draftScheduleRawRef.current,
      weekIndex,
      currentRestaurantId,
      applied.draftRows
    );
    suppressHydrateUndoClearRef.current = true;
    setAssignmentStore(applied.store);
    setRolledDraftRaw(draftPayload);
    applyLocalScheduleAssignments(applied.store, draftPayload);
    queuePersist(applied.store, draftPayload);
    return true;
  }

  function openShiftEditor(target: ShiftEditTarget) {
    if (!scheduleEditable) return;
    captureScheduleScroll();
    setShiftPersonBorrowMode(false);
    const wk = weekdayKeyFromScheduleDay(target.dayStr);
    const di = WEEKDAY_KEYS.indexOf(wk);
    if (target.shift) {
      const parsed = parseBreakAnnotation(target.shift.redPokeBreak || '');
      setEditDayOff(false);
      setEditStart(
        parsed.type === 'OFFICE'
          ? OFFICE_DEFAULT_START_HHMM
          : target.shift.start || '10:00'
      );
      setEditEnd(target.shift.end || '18:00');
      setEditBreakType(parsed.type);
      const breakLabel =
        parsed.type === 'NO BREAK'
          ? ''
          : clampBreakTimeLabel(parsed.type, parsed.time || '3:00PM');
      setEditBreakTime(
        parsed.type === 'NO BREAK'
          ? '15:00'
          : breakAnnotationTimeToHHMM(breakLabel) || '15:00'
      );
      const w = (target.shift.workers || []).find((n) => n && n !== 'Unassigned');
      setEditWorker(w || 'Unassigned');
    } else {
      const defs = defaultTimesForDraftCell(draftRows, target.role, target.trIdx, di < 0 ? 0 : di);
      setEditDayOff(true);
      setEditStart(defs[0]);
      setEditEnd(defs[1]);
      setEditBreakType('BREAK TIME');
      setEditBreakTime('15:00');
      const rowPerson = scheduleRowPrimaryPerson(
        schedule,
        target.role,
        target.trIdx,
        visibleDays,
        lites,
        currentRestaurantId,
        assignmentStoreRef.current,
        weekIndex
      );
      setEditWorker(rowPerson && rowPerson !== 'Unassigned' ? rowPerson : 'Unassigned');
    }
    setShiftEditor(target);
  }

  function onCellPress(target: ShiftEditTarget) {
    if (!scheduleEditable) return;
    if (copyTimesClip) {
      pasteCopyTimesOntoCell(target);
      return;
    }
    openShiftEditor(target);
  }

  function pasteCopyTimesOntoCell(target: ShiftEditTarget) {
    if (!copyTimesClip || !scheduleEditable) return;
    captureScheduleScroll();
    const breakText =
      copyTimesClip.breakType === 'NO BREAK'
        ? formatBreakAnnotation('', 'NO BREAK')
        : formatBreakAnnotation(copyTimesClip.breakTimeLabel, copyTimesClip.breakType);
    let workers: string[] | null = null;
    if (target.shift) {
      const w = (target.shift.workers || []).find((n) => n && n !== 'Unassigned');
      workers = w ? [w] : ['Unassigned'];
    } else {
      const rowPerson = scheduleRowPrimaryPerson(
        schedule,
        target.role,
        target.trIdx,
        visibleDays,
        lites,
        currentRestaurantId,
        assignmentStoreRef.current,
        weekIndex
      );
      workers =
        rowPerson && rowPerson !== 'Unassigned' ? [rowPerson] : ['Unassigned'];
    }
    const ok = persistSlotEdit({
      role: target.role,
      trIdx: target.trIdx,
      dayStr: target.dayStr,
      start: copyTimesClip.start,
      end: copyTimesClip.end,
      isDayOff: false,
      breakText,
      workers,
    });
    setCopyTimesClip(null);
    if (!ok) {
      Alert.alert(t('schedule.couldNotSave'), t('schedule.checkTimes'));
      return;
    }
    restoreScheduleScroll();
  }

  function clearCellToDayOff(target: ShiftEditTarget) {
    if (!scheduleEditable) return;
    captureScheduleScroll();
    const start = target.shift?.start || '10:00';
    const end = target.shift?.end || '18:00';
    const ok = persistSlotEdit({
      role: target.role,
      trIdx: target.trIdx,
      dayStr: target.dayStr,
      start,
      end,
      isDayOff: true,
      breakText: null,
      workers: null,
    });
    if (!ok) {
      Alert.alert(t('schedule.couldNotSave'), t('schedule.checkTimes'));
      return;
    }
    restoreScheduleScroll();
  }

  function onCellLongPress(target: ShiftEditTarget) {
    if (!scheduleEditable) return;
    const buttons: {
      text: string;
      style?: 'cancel' | 'destructive' | 'default';
      onPress?: () => void;
    }[] = [];
    if (copyTimesClip) {
      buttons.push({
        text: t('schedule.pasteTimes'),
        onPress: () => pasteCopyTimesOntoCell(target),
      });
      buttons.push({
        text: t('schedule.cancelCopy'),
        onPress: () => setCopyTimesClip(null),
      });
    }
    if (target.shift) {
      buttons.push({
        text: t('schedule.copyTimes'),
        onPress: () => {
          const parsed = parseBreakAnnotation(target.shift!.redPokeBreak || '');
          const breakType = parsed.type;
          const breakTimeLabel =
            breakType === 'NO BREAK'
              ? ''
              : clampBreakTimeLabel(breakType, parsed.time || '3:00PM');
          setCopyTimesClip({
            start:
              breakType === 'OFFICE'
                ? OFFICE_DEFAULT_START_HHMM
                : target.shift!.start || '10:00',
            end: target.shift!.end || '18:00',
            breakType,
            breakTimeLabel,
          });
        },
      });
    }
    buttons.push({
      text: t('schedule.markDayOff'),
      style: 'destructive',
      onPress: () => clearCellToDayOff(target),
    });
    buttons.push({
      text: t('common.edit'),
      onPress: () => {
        setCopyTimesClip(null);
        openShiftEditor(target);
      },
    });
    buttons.push({ text: t('common.cancel'), style: 'cancel' });
    Alert.alert(t('schedule.cellActions'), t('schedule.cellActionsHint'), buttons);
  }

  function applyShiftDetailsSave() {
    if (!shiftEditor || !isManagerLikeRole(role) || !scheduleEditable) return;
    if (editWorker === SCHEDULE_BORROW_PERSON_VALUE) {
      setShiftPersonBorrowMode(true);
      return;
    }
    const wk = weekdayKeyFromScheduleDay(shiftEditor.dayStr);
    const di = WEEKDAY_KEYS.indexOf(wk);
    if (di < 0) return;
    let start = editStart;
    let end = editEnd;
    let breakType = editBreakType;
    let breakTimeRaw = editBreakTime;
    if (!editDayOff) {
      if (breakType === 'OFFICE') {
        start = OFFICE_DEFAULT_START_HHMM;
        breakTimeRaw = breakAnnotationTimeToHHMM(OFFICE_DEFAULT_BREAK_TIME) || '14:00';
      }
      if (!/^\d{1,2}:\d{2}$/.test(start.trim()) || !/^\d{1,2}:\d{2}$/.test(end.trim())) {
        Alert.alert(t('schedule.invalidTime'), t('schedule.invalidTimeHint'));
        return;
      }
      if (breakType !== 'NO BREAK' && !normalizeBreakAnnotationTime(breakTimeRaw)) {
        Alert.alert(t('schedule.invalidBreakTime'), t('schedule.invalidBreakHint'));
        return;
      }
    }
    const breakLabel =
      breakType === 'NO BREAK'
        ? ''
        : clampBreakTimeLabel(breakType, normalizeBreakAnnotationTime(breakTimeRaw) || '3:00PM');
    const breakText = formatBreakAnnotation(breakLabel || '3:00PM', breakType);
    const list =
      editWorker === 'Unassigned' ? ['Unassigned'] : [editWorker].filter(Boolean);
    void (async () => {
      if (!editDayOff && editWorker !== 'Unassigned') {
        const emp = employees.find((e) => employeeDisplayName(e) === editWorker) || null;
        await ensureWeekBorrowForEmployee(emp);
      }
      const ok = persistSlotEdit({
        role: shiftEditor.role,
        trIdx: shiftEditor.trIdx,
        dayStr: shiftEditor.dayStr,
        start,
        end,
        isDayOff: editDayOff,
        breakText,
        workers: editDayOff ? null : list,
      });
      if (!ok) {
        Alert.alert(t('schedule.couldNotSave'), t('schedule.checkTimes'));
        return;
      }
      setShiftPersonBorrowMode(false);
      setShiftEditor(null);
      restoreScheduleScroll();
    })();
  }

  function addSlotForRole(roleKey: RoleKey) {
    if (!isManagerLikeRole(role) || !scheduleEditable) return;
    const nextRows = addDraftSlotRow(draftRows, roleKey);
    if (!nextRows) {
      Alert.alert(t('schedule.limitReached'), t('schedule.maxSlots'));
      return;
    }
    pushUndoSnapshot();
    suppressHydrateUndoClearRef.current = true;
    let draftPayload = patchDraftScheduleForWeek(
      draftScheduleRaw,
      weekIndex,
      currentRestaurantId,
      nextRows
    );
    const newTrIdx = slotCountForRole(nextRows, roleKey) - 1;
    draftPayload = patchSlotOrderAfterAdd(
      draftPayload,
      selectedWeekMonday,
      currentRestaurantId,
      roleKey,
      newTrIdx
    );
    setRolledDraftRaw(draftPayload);
    applyLocalScheduleAssignments(assignmentStore, draftPayload);
    queuePersist(assignmentStore, draftPayload);
  }

  function deleteSlotForRole(roleKey: RoleKey, trIdx: number) {
    if (!isManagerLikeRole(role) || !scheduleEditable) return;
    const runDelete = () => {
      const liveDraft = loadDraftFromTeamState(
        draftScheduleRawRef.current,
        weekIndex,
        currentRestaurantId
      );
      const liveStore = assignmentStoreRef.current;
      pushUndoSnapshot();
      const nextRows = deleteDraftSlotRow(liveDraft, roleKey, trIdx);
      if (!nextRows) {
        Alert.alert(t('schedule.cannotDelete'), t('schedule.keepOneSlot'));
        return;
      }
      suppressHydrateUndoClearRef.current = true;
      const nextStore = compactAssignmentsAfterDraftSlotDeletes(
        liveStore,
        currentRestaurantId,
        weekIndex,
        [{ role: roleKey, originalTrIdx: trIdx }]
      );
      let draftPayload = patchDraftScheduleForWeek(
        draftScheduleRawRef.current,
        weekIndex,
        currentRestaurantId,
        nextRows
      );
      draftPayload = patchSlotOrderAfterDelete(
        draftPayload,
        selectedWeekMonday,
        currentRestaurantId,
        roleKey,
        trIdx
      );
      setAssignmentStore(nextStore);
      setRolledDraftRaw(draftPayload);
      applyLocalScheduleAssignments(nextStore, draftPayload);
      queuePersist(nextStore, draftPayload);
    };
    const liveDraft = loadDraftFromTeamState(
      draftScheduleRawRef.current,
      weekIndex,
      currentRestaurantId
    );
    if (
      draftSlotRowHasContent(
        liveDraft,
        assignmentStoreRef.current,
        currentRestaurantId,
        roleKey,
        trIdx,
        weekIndex
      )
    ) {
      Alert.alert(
        t('schedule.deleteSlot'),
        t('schedule.deleteSlotConfirm', { n: trIdx + 1 }),
        [
          { text: t('common.cancel'), style: 'cancel' },
          { text: t('common.delete'), style: 'destructive', onPress: runDelete },
        ]
      );
      return;
    }
    runDelete();
  }

  function moveScheduleRow(roleKey: RoleKey, trIdx: number, direction: -1 | 1) {
    if (!isManagerLikeRole(role) || !scheduleEditable) return;
    const slotN = slotCountForRoleWithAssignments(
      draftRows,
      roleKey,
      assignmentStore,
      currentRestaurantId,
      weekIndex
    );
    if (slotN <= 1) return;
    const existing = getCustomSlotOrderForRole(
      slotOrderByRestaurant,
      currentRestaurantId,
      roleKey,
      slotN
    );
    const baseOrder =
      existing ||
      orderedScheduleSlotIndicesForRole(
        schedule,
        roleKey,
        slotN,
        visibleDays,
        lites,
        currentRestaurantId,
        null,
        assignmentStore,
        weekIndex
      );
    const nextOrder = moveTrIdxInSlotOrder(baseOrder, trIdx, direction);
    if (!nextOrder) return;
    pushUndoSnapshot();
    suppressHydrateUndoClearRef.current = true;
    const draftPayload = patchSlotOrderInDraftSchedule(
      draftScheduleRawRef.current ?? draftScheduleRaw,
      selectedWeekMonday,
      currentRestaurantId,
      roleKey,
      nextOrder
    );
    setRolledDraftRaw(draftPayload);
    applyLocalScheduleAssignments(assignmentStoreRef.current, draftPayload);
    queuePersist(assignmentStoreRef.current, draftPayload);
  }

  async function ensureWeekBorrowForEmployee(emp: EmployeeRow | null | undefined) {
    if (!emp || !employeeEligibleForWeekBorrow(emp)) return;
    const home = emp.usualRestaurant || 'both';
    if (home === 'both' || home === currentRestaurantId) return;
    if (currentRestaurantId !== 'rp-8' && currentRestaurantId !== 'rp-9') return;
    if (home !== 'rp-8' && home !== 'rp-9') return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(selectedWeekMonday)) return;
    const bounds = getPayWeekBoundsForMonday(new Date(`${selectedWeekMonday}T12:00:00`));
    await setEmployeeBorrowedRestaurant(
      emp.id,
      bounds,
      currentRestaurantId as BorrowRestaurantId
    );
    setBorrowByEmpId((prev) => ({ ...prev, [emp.id]: currentRestaurantId }));
  }

  async function applyRowPersonChoice(target: RowPersonTarget, workerName: string) {
    if (!scheduleEditable) return;
    if (workerName === SCHEDULE_BORROW_PERSON_VALUE) {
      setRowPersonBorrowMode(true);
      return;
    }
    if (rowPersonBorrowMode && workerName !== 'Unassigned') {
      const emp = employees.find((e) => employeeDisplayName(e) === workerName) || null;
      await ensureWeekBorrowForEmployee(emp);
    }
    const next = assignPersonToScheduleRow(
      assignmentStore,
      schedule,
      currentRestaurantId,
      target.role,
      target.trIdx,
      visibleDays,
      workerName,
      lites,
      weekIndex
    );
    if (next === assignmentStore) {
      setRowPersonBorrowMode(false);
      setRowPersonPicker(null);
      return;
    }
    pushUndoSnapshot();
    suppressHydrateUndoClearRef.current = true;
    setAssignmentStore(next);
    applyLocalScheduleAssignments(next);
    queuePersist(next);
    setRowPersonBorrowMode(false);
    setRowPersonPicker(null);
  }

  const rowPickerNames = useMemo(() => {
    if (!rowPersonPicker) return [] as string[];
    if (rowPersonBorrowMode) {
      return namesForScheduleBorrowPersonPicker(
        lites,
        rowPersonPicker.role,
        currentRestaurantId
      );
    }
    const selected = scheduleRowPrimaryPerson(
      schedule,
      rowPersonPicker.role,
      rowPersonPicker.trIdx,
      visibleDays,
      lites,
      currentRestaurantId,
      assignmentStore,
      weekIndex
    );
    const pool = namesForScheduleRowPersonPicker(lites, rowPersonPicker.role, currentRestaurantId);
    const base =
      selected && selected !== 'Unassigned'
        ? (() => {
            const selKey = selected.trim().toLowerCase();
            const inPool = pool.some((n) => n.trim().toLowerCase() === selKey);
            return inPool
              ? (['Unassigned', ...pool] as string[])
              : (['Unassigned', selected, ...pool] as string[]);
          })()
        : (['Unassigned', ...pool] as string[]);
    return [...base, SCHEDULE_BORROW_PERSON_VALUE];
  }, [
    rowPersonPicker,
    rowPersonBorrowMode,
    schedule,
    visibleDays,
    lites,
    currentRestaurantId,
    assignmentStore,
    weekIndex,
  ]);

  const shiftPickerNames = useMemo(() => {
    if (!shiftEditor) return [] as string[];
    if (shiftPersonBorrowMode) {
      return namesForScheduleBorrowPersonPicker(lites, shiftEditor.role, currentRestaurantId);
    }
    const pool = namesForScheduleRowPersonPicker(lites, shiftEditor.role, currentRestaurantId);
    const selected = editWorker && editWorker !== 'Unassigned' ? editWorker : '';
    const base =
      selected && selected !== SCHEDULE_BORROW_PERSON_VALUE
        ? (() => {
            const selKey = selected.trim().toLowerCase();
            const inPool = pool.some((n) => n.trim().toLowerCase() === selKey);
            return inPool
              ? (['Unassigned', ...pool] as string[])
              : (['Unassigned', selected, ...pool] as string[]);
          })()
        : (['Unassigned', ...pool] as string[]);
    const borrowPool = namesForScheduleBorrowPersonPicker(
      lites,
      shiftEditor.role,
      currentRestaurantId
    );
    return borrowPool.length ? [...base, SCHEDULE_BORROW_PERSON_VALUE] : base;
  }, [shiftEditor, shiftPersonBorrowMode, lites, currentRestaurantId, editWorker]);

  const editHoursLabel = useMemo(() => {
    if (editDayOff) return '';
    if (!/^\d{1,2}:\d{2}$/.test(editStart) || !/^\d{1,2}:\d{2}$/.test(editEnd)) return '';
    return `${redPokeShiftHoursDecimal(editStart, editEnd)} h`;
  }, [editDayOff, editStart, editEnd]);

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

  const breakTimeChipLabels = useMemo(
    () => breakTimePresetsForType(editBreakType, normalizeBreakAnnotationTime(editBreakTime) || ''),
    [editBreakType, editBreakTime]
  );

  const modalOpen = !!shiftEditor || !!rowPersonPicker;

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <ScrollView
        ref={outerScrollRef}
        style={styles.gridScroll}
        contentContainerStyle={styles.gridScrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        onScroll={(e) => {
          outerScrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
      <View style={styles.chrome}>
        <View style={styles.brandRow}>
          <Image
            source={require('../../assets/red-poke-logo.png')}
            style={styles.brandLogo}
            accessibilityLabel="Red Poke"
          />
        </View>

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
          <View style={styles.toolbarActions}>
            <Pressable
              onPress={publishSelectedWeek}
              disabled={publishing || selectedWeekIsPast || !scheduleEditable}
              style={[
                styles.publishBtn,
                (publishing || selectedWeekIsPast || !scheduleEditable) && styles.publishBtnDisabled,
              ]}
            >
              <Text style={styles.publishBtnText}>
                {publishing
                  ? t('common.publishing')
                  : !scheduleEditable
                    ? t('schedule.viewOnly')
                    : selectedWeekIsPast
                      ? t('schedule.pastWeek')
                      : selectedWeekPublished
                        ? t('common.notifyAgain')
                        : t('schedule.publishNotify')}
              </Text>
            </Pressable>
            {isManagerLikeRole(role) && scheduleEditable ? (
              <Pressable
                onPress={undoLastChange}
                disabled={undoDepth === 0}
                style={[styles.undoBtn, undoDepth === 0 && styles.undoBtnDisabled]}
                accessibilityRole="button"
                accessibilityLabel="Undo last schedule change"
              >
                <Text style={[styles.undoBtnText, undoDepth === 0 && styles.undoBtnTextDisabled]}>
                  {t('schedule.undo')}
                </Text>
              </Pressable>
            ) : null}
            {isManagerLikeRole(role) && scheduleEditable ? (
              <Pressable
                onPress={() => void openScheduleHistory()}
                style={styles.undoBtn}
                accessibilityRole="button"
                accessibilityLabel={t('schedule.history')}
              >
                <Text style={styles.undoBtnText}>{t('schedule.history')}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>

        <View style={styles.locRow}>
          <Text style={styles.toolbarLabel}>{t('common.location')}</Text>
          <View style={styles.locRowContent}>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              style={styles.locChipsScroll}
              contentContainerStyle={styles.chipsRow}
            >
              {scheduleRestaurants.map((r) => (
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
            <View style={styles.locActions}>
              {loading ? <ActivityIndicator /> : null}
              {saving ? <Text style={styles.syncHint}>{t('common.saving')}</Text> : null}
              <Pressable
                onPress={() => {
                  clearUndoStack();
                  void refetch();
                }}
                style={styles.refreshBtn}
              >
                <Text style={styles.refreshTxt}>{t('common.refresh')}</Text>
              </Pressable>
            </View>
          </View>
        </View>
        {!scheduleEditable ? (
          <Text style={styles.viewOnlyHint}>{t('schedule.viewOnlyOtherStoreHint')}</Text>
        ) : null}
        {copyTimesClip ? (
          <Pressable style={styles.copyBanner} onPress={() => setCopyTimesClip(null)}>
            <Text style={styles.copyBannerText}>{t('schedule.copyModeHint')}</Text>
            <Text style={styles.copyBannerCancel}>{t('schedule.cancelCopy')}</Text>
          </Pressable>
        ) : null}

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

        <View style={styles.matrix}>
          <ScrollView
            ref={dayScrollRef}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            keyboardShouldPersistTaps="handled"
            onScroll={(e) => {
              dayScrollXRef.current = e.nativeEvent.contentOffset.x;
            }}
            scrollEventThrottle={16}
          >
          <View style={styles.matrixInner}>
            <View style={[styles.personCol, { width: PERSON_COL }]}>
              <View style={styles.personTh}>
                <Text style={styles.thFull}>{t('schedule.personHeader')}</Text>
                <Text style={styles.thSub}>{t('schedule.rowAssignee')}</Text>
              </View>
              {calendarBody.map((row, ri) => {
                const move =
                  row.kind === 'cells'
                    ? slotMoveFlags.get(`${row.role}:${row.trIdx}`)
                    : undefined;
                return (
                  <PersonColRow
                    key={`p-${ri}`}
                    row={row}
                    schedule={schedule}
                    visibleDays={visibleDays}
                    employees={lites}
                    restaurantId={currentRestaurantId}
                    assignmentStore={assignmentStore}
                    weekIndex={weekIndex}
                    editable={scheduleEditable}
                    onOpenRowPerson={(t) => {
                      setRowPersonBorrowMode(false);
                      setRowPersonPicker(t);
                    }}
                    onAddSlot={addSlotForRole}
                    onDeleteSlot={deleteSlotForRole}
                    onMoveRow={moveScheduleRow}
                    canMoveUp={!!move?.up}
                    canMoveDown={!!move?.down}
                  />
                );
              })}
              <View
                style={[
                  styles.personSection,
                  styles.sectionMatrixRow,
                  { backgroundColor: '#f8fafc', borderLeftColor: '#64748b' },
                ]}
              >
                <Text style={[styles.sectionText, styles.groupOrderSectionTitle]} numberOfLines={2}>
                  {t('schedule.groupOrderPotential')}
                </Text>
              </View>
              {GROUP_ORDER_POTENTIAL_PLATFORMS.map((plat) => (
                <View key={`go-p-${plat.id}`} style={[styles.personCell, styles.dataMatrixRow]}>
                  <Text style={styles.groupOrderPersonLabel}>{plat.label}</Text>
                </View>
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
                    <DayColRow
                      key={`d-${ri}`}
                      row={row}
                      daysWidth={daysWidth}
                      editable={scheduleEditable}
                      onOpenShift={onCellPress}
                      onLongPressShift={onCellLongPress}
                      onMarkDayOff={clearCellToDayOff}
                    />
                  ))}
                  <View
                    style={[
                      styles.sectionDayFill,
                      styles.sectionMatrixRow,
                      {
                        width: daysWidth,
                        backgroundColor: '#f8fafc',
                      },
                    ]}
                  />
                  {GROUP_ORDER_POTENTIAL_PLATFORMS.map((plat, gi) => (
                    <View
                      key={`go-d-${plat.id}`}
                      style={[
                        styles.dataDays,
                        styles.dataMatrixRow,
                        styles.groupOrderDataRow,
                        gi % 2 === 1 && styles.groupOrderDataRowAlt,
                        { width: daysWidth },
                      ]}
                    >
                      {visibleDays.map((dayStr) => {
                        const meta = weekMeta.find((m) => m.label === dayStr);
                        const dayIso = meta?.iso ? String(meta.iso).slice(0, 10) : '';
                        const stored = getGroupOrderPotentialCell(
                          draftScheduleRaw,
                          selectedWeekMonday,
                          currentRestaurantId,
                          plat.id,
                          dayIso
                        );
                        const val = stored !== '' ? stored : '0';
                        return (
                          <View
                            key={`${plat.id}-${dayStr}`}
                            style={[styles.groupOrderCell, { width: CELL_MIN }]}
                          >
                            {scheduleEditable ? (
                              <TextInput
                                key={`${plat.id}-${dayIso}-${selectedWeekMonday}-${currentRestaurantId}-${val}`}
                                style={styles.groupOrderInput}
                                defaultValue={val}
                                placeholder="0"
                                placeholderTextColor="#94a3b8"
                                keyboardType="decimal-pad"
                                selectTextOnFocus
                                onEndEditing={(e) => {
                                  const text = e.nativeEvent.text;
                                  if (text === stored || (text === '0' && stored === '')) return;
                                  const next = patchGroupOrderPotentialInDraft(
                                    draftScheduleRawRef.current ?? draftScheduleRaw,
                                    selectedWeekMonday,
                                    currentRestaurantId,
                                    plat.id,
                                    dayIso,
                                    text
                                  );
                                  pushUndoSnapshot();
                                  suppressHydrateUndoClearRef.current = true;
                                  setRolledDraftRaw(next);
                                  applyLocalScheduleAssignments(assignmentStoreRef.current, next);
                                  queuePersist(assignmentStoreRef.current, next);
                                }}
                                autoCapitalize="none"
                                autoCorrect={false}
                              />
                            ) : (
                              <Text style={styles.groupOrderReadonly}>{val}</Text>
                            )}
                          </View>
                        );
                      })}
                    </View>
                  ))}
                </View>
                {scheduleEditable ? (
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
                    <View
                      style={[
                        styles.personTotalsSection,
                        {
                          height: SECTION_ROW_H + SECTION_GAP_BELOW,
                          backgroundColor: '#f8fafc',
                        },
                      ]}
                    />
                    {GROUP_ORDER_POTENTIAL_PLATFORMS.map((plat) => (
                      <View
                        key={`pt-go-${plat.id}`}
                        style={[styles.personTotalsCell, styles.groupOrderDataRow, { opacity: 0 }]}
                      />
                    ))}
                  </View>
                ) : null}
          </View>
            </ScrollView>
        </View>
      </ScrollView>

      <Modal visible={historyOpen} animationType="slide" transparent>
        <Pressable style={styles.modalBackdrop} onPress={() => setHistoryOpen(false)}>
          <Pressable style={[styles.modalPanel, styles.modalPanelTall]} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.modalTitle}>{t('schedule.history')}</Text>
            <Text style={styles.modalSub}>{t('schedule.historyHint')}</Text>
            {historyLoading ? (
              <ActivityIndicator style={{ marginTop: 20 }} />
            ) : !historyRows.length ? (
              <Text style={styles.modalSub}>{t('schedule.historyEmpty')}</Text>
            ) : (
              <FlatList
                data={historyRows}
                keyExtractor={(item) => item.id}
                style={styles.modalList}
                renderItem={({ item }) => (
                  <View style={styles.historyRow}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={styles.modalRowText} numberOfLines={2}>
                        {item.label || formatScheduleRevisionLabel(item.source, new Date(item.created_at))}
                      </Text>
                      <Text style={styles.historyMeta}>{item.source}</Text>
                    </View>
                    <Pressable
                      style={[styles.historyRevertBtn, historyBusyId === item.id && styles.publishBtnDisabled]}
                      disabled={!!historyBusyId}
                      onPress={() => hardRevertToRevision(item.id)}
                    >
                      <Text style={styles.historyRevertBtnText}>
                        {historyBusyId === item.id ? t('common.publishing') : t('schedule.hardRevert')}
                      </Text>
                    </Pressable>
                  </View>
                )}
              />
            )}
            <Pressable style={styles.undoBtn} onPress={() => setHistoryOpen(false)}>
              <Text style={styles.undoBtnText}>{t('common.close')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      <Modal visible={modalOpen} animationType="slide" transparent>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setShiftEditor(null);
            setShiftPersonBorrowMode(false);
            setRowPersonBorrowMode(false);
            setRowPersonPicker(null);
            restoreScheduleScroll();
          }}
        >
          <Pressable style={[styles.modalPanel, shiftEditor && styles.modalPanelTall]} onPress={(e) => e.stopPropagation()}>
            {rowPersonPicker ? (
              <>
                <Text style={styles.modalTitle}>
                  {rowPersonBorrowMode
                    ? t('schedule.borrowEmployeeTitle')
                    : t('schedule.assignRowPerson')}
                </Text>
                <Text style={styles.modalSub} numberOfLines={4}>
                  {rowPersonBorrowMode
                    ? t('schedule.borrowEmployeeHint')
                    : t('schedule.assignRowSub', {
                        role: staffTypeLabel(rowPersonPicker.role),
                        n: rowPersonPicker.trIdx + 1,
                      })}
                </Text>
                <FlatList
                  data={rowPickerNames}
                  keyExtractor={(item) => item}
                  style={styles.modalList}
                  ListEmptyComponent={
                    rowPersonBorrowMode ? (
                      <Text style={styles.modalSub}>{t('schedule.borrowEmpty')}</Text>
                    ) : null
                  }
                  renderItem={({ item }) => {
                    const isSentinel = item === SCHEDULE_BORROW_PERSON_VALUE;
                    const meta =
                      rowPersonBorrowMode && !isSentinel
                        ? borrowHomeMeta(liteByScheduleName(lites, item), t)
                        : '';
                    return (
                    <Pressable
                      style={styles.modalRow}
                      onPress={() => void applyRowPersonChoice(rowPersonPicker, item)}
                    >
                      <Text style={styles.modalRowText}>
                        {isSentinel ? t('schedule.borrowEmployee') : item}
                      </Text>
                      {meta ? <Text style={styles.modalRowMeta}>{meta}</Text> : null}
                    </Pressable>
                    );
                  }}
                />
              </>
            ) : shiftEditor ? (
              <ScrollView keyboardShouldPersistTaps="handled">
                <Text style={styles.modalTitle}>{t('title.editShift')}</Text>
                <Text style={styles.modalSub} numberOfLines={3}>
                  {t('schedule.editShiftSub', {
                    role: staffTypeLabel(shiftEditor.role),
                    day: shiftEditor.dayStr,
                    n: shiftEditor.trIdx + 1,
                  })}
                </Text>
                <View style={styles.editRow}>
                  <Text style={styles.editLabel}>{t('schedule.dayOffToggle')}</Text>
                  <Switch value={editDayOff} onValueChange={setEditDayOff} />
                </View>
                {!editDayOff ? (
                  <>
                    <View style={styles.editTimesRow}>
                      <View style={styles.editField}>
                        <Text style={styles.editFieldLabel}>{t('common.start')}</Text>
                        <TextInput
                          style={[
                            styles.editInput,
                            editBreakType === 'OFFICE' && styles.editInputLocked,
                          ]}
                          value={editStart}
                          onChangeText={setEditStart}
                          editable={editBreakType !== 'OFFICE'}
                          placeholder="10:00"
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                      <Text style={styles.editSep}>–</Text>
                      <View style={styles.editField}>
                        <Text style={styles.editFieldLabel}>{t('common.end')}</Text>
                        <TextInput
                          style={styles.editInput}
                          value={editEnd}
                          onChangeText={setEditEnd}
                          placeholder="18:00"
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                      {editHoursLabel ? <Text style={styles.editHours}>{editHoursLabel}</Text> : null}
                    </View>
                    <Text style={styles.editFieldLabel}>{t('schedule.breakOffice')}</Text>
                    <View style={styles.chipWrap}>
                      {BREAK_ANNOTATION_TYPE_PRESETS.map((breakType) => (
                        <Pressable
                          key={breakType}
                          onPress={() => applyBreakTypeChange(breakType)}
                          style={[
                            styles.editChip,
                            editBreakType === breakType && styles.editChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.editChipText,
                              editBreakType === breakType && styles.editChipTextActive,
                            ]}
                          >
                            {breakType === 'BREAK TIME'
                              ? t('schedule.breakTime')
                              : breakType === 'OFFICE'
                                ? t('schedule.office')
                                : t('schedule.noBreak')}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    {editBreakType !== 'NO BREAK' ? (
                      <View style={{ marginTop: 10 }}>
                        <Text style={styles.editFieldLabel}>{t('schedule.assignedTime')}</Text>
                        <View style={styles.chipWrap}>
                          {breakTimeChipLabels.map((label) => {
                            const selected =
                              normalizeBreakAnnotationTime(editBreakTime) === label;
                            return (
                              <Pressable
                                key={label}
                                onPress={() =>
                                  setEditBreakTime(breakAnnotationTimeToHHMM(label) || '15:00')
                                }
                                style={[styles.editChip, selected && styles.editChipActive]}
                              >
                                <Text
                                  style={[
                                    styles.editChipText,
                                    selected && styles.editChipTextActive,
                                  ]}
                                >
                                  {label}
                                </Text>
                              </Pressable>
                            );
                          })}
                        </View>
                      </View>
                    ) : null}
                    <Text style={[styles.editFieldLabel, { marginTop: 12 }]}>
                      {shiftPersonBorrowMode
                        ? t('schedule.borrowEmployeeTitle')
                        : t('common.person')}
                    </Text>
                    {shiftPersonBorrowMode ? (
                      <Text style={styles.modalSub} numberOfLines={3}>
                        {t('schedule.borrowEmployeeHint')}
                      </Text>
                    ) : null}
                    {shiftPersonBorrowMode ? (
                      <Pressable
                        style={[styles.editChip, { marginBottom: 8, alignSelf: 'flex-start' }]}
                        onPress={() => setShiftPersonBorrowMode(false)}
                      >
                        <Text style={styles.editChipText}>{t('common.back')}</Text>
                      </Pressable>
                    ) : null}
                    <View style={styles.chipWrap}>
                      {shiftPickerNames.map((name) => (
                        <Pressable
                          key={name}
                          onPress={() => {
                            if (name === SCHEDULE_BORROW_PERSON_VALUE) {
                              setShiftPersonBorrowMode(true);
                              return;
                            }
                            setEditWorker(name);
                            if (shiftPersonBorrowMode) setShiftPersonBorrowMode(false);
                          }}
                          style={[
                            styles.editChip,
                            editWorker === name &&
                              name !== SCHEDULE_BORROW_PERSON_VALUE &&
                              styles.editChipActive,
                          ]}
                        >
                          <Text
                            style={[
                              styles.editChipText,
                              editWorker === name &&
                                name !== SCHEDULE_BORROW_PERSON_VALUE &&
                                styles.editChipTextActive,
                            ]}
                          >
                            {name === SCHEDULE_BORROW_PERSON_VALUE
                              ? t('schedule.borrowEmployee')
                              : name === 'Unassigned'
                                ? t('common.unassigned')
                                : name}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  </>
                ) : null}
                <Pressable style={styles.saveBtn} onPress={applyShiftDetailsSave}>
                  <Text style={styles.saveBtnText}>{t('schedule.saveShift')}</Text>
                </Pressable>
              </ScrollView>
            ) : null}
            <Pressable
              style={styles.modalCancel}
              onPress={() => {
                setShiftEditor(null);
                setShiftPersonBorrowMode(false);
                setRowPersonBorrowMode(false);
                setRowPersonPicker(null);
                restoreScheduleScroll();
              }}
            >
              <Text style={styles.modalCancelText}>{t('common.cancel')}</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

type PersonColRowProps = {
  row: CalendarBodyRow;
  schedule: ScheduleRow[];
  visibleDays: string[];
  employees: EmployeeLite[];
  restaurantId: string;
  assignmentStore: AssignmentStore;
  weekIndex: number;
  editable: boolean;
  onOpenRowPerson: (t: RowPersonTarget) => void;
  onAddSlot: (role: RoleKey) => void;
  onDeleteSlot: (role: RoleKey, trIdx: number) => void;
  onMoveRow: (role: RoleKey, trIdx: number, direction: -1 | 1) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
};

const PersonColRow = memo(function PersonColRow({
  row,
  schedule,
  visibleDays,
  employees,
  restaurantId,
  assignmentStore,
  weekIndex,
  editable,
  onOpenRowPerson,
  onAddSlot,
  onDeleteSlot,
  onMoveRow,
  canMoveUp,
  canMoveDown,
}: PersonColRowProps) {
  const { t, staffTypeLabel } = useI18n();
  if (row.kind === 'section') {
    const bg = sectionBg(row.variant);
    const fg = sectionFg(row.variant);
    const addRole: RoleKey =
      row.variant === 'foh' ? 'Bartender' : row.variant === 'delivery' ? 'Server' : 'Kitchen';
    const sectionTitle = staffTypeLabel(addRole);
    return (
      <View
        style={[
          styles.personSection,
          styles.sectionMatrixRow,
          {
            backgroundColor: bg,
            borderLeftColor: fg,
          },
        ]}
      >
        <Text style={[styles.sectionText, { color: fg }]} numberOfLines={2}>
          {sectionTitle}
        </Text>
        {editable ? (
          <Pressable
            onPress={() => onAddSlot(addRole)}
            style={styles.addSlotBtn}
            accessibilityRole="button"
            accessibilityLabel={`${t('schedule.addSlot')} · ${sectionTitle}`}
          >
            <Text style={styles.addSlotBtnText}>{t('schedule.addSlot')}</Text>
          </Pressable>
        ) : null}
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
  const label =
    selected && selected !== 'Unassigned' ? selected : t('common.unassigned');
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
      <View style={styles.personRowTop}>
        {editable ? (
          <Pressable
            style={styles.personSelect}
            onPress={() => onOpenRowPerson({ role: row.role, trIdx: row.trIdx })}
            accessibilityRole="button"
            accessibilityLabel={`Person for ${STAFF_TYPE_LABELS[row.role]} row ${row.trIdx + 1}`}
          >
            <Text style={styles.personSelectText} numberOfLines={1} ellipsizeMode="tail">
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
          </Pressable>
        ) : (
          <View style={styles.personSelect}>
            <Text style={styles.personSelectText} numberOfLines={1} ellipsizeMode="tail">
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
        )}
        {editable ? (
          <View style={styles.reorderCol}>
            <Pressable
              onPress={() => onMoveRow(row.role, row.trIdx, -1)}
              disabled={!canMoveUp}
              style={[styles.reorderBtn, !canMoveUp && styles.reorderBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={`Move ${label} up`}
            >
              <Text style={styles.reorderBtnText}>↑</Text>
            </Pressable>
            <Pressable
              onPress={() => onMoveRow(row.role, row.trIdx, 1)}
              disabled={!canMoveDown}
              style={[styles.reorderBtn, !canMoveDown && styles.reorderBtnDisabled]}
              accessibilityRole="button"
              accessibilityLabel={`Move ${label} down`}
            >
              <Text style={styles.reorderBtnText}>↓</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
      {editable ? (
        <Pressable
          onPress={() => onDeleteSlot(row.role, row.trIdx)}
          style={styles.deleteSlotBtn}
          accessibilityRole="button"
          accessibilityLabel={`${t('schedule.deleteSlot')} ${row.trIdx + 1}`}
        >
          <Text style={styles.deleteSlotBtnText}>{t('schedule.deleteSlot')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const DayColRow = memo(function DayColRow({
  row,
  daysWidth,
  editable,
  onOpenShift,
  onLongPressShift,
  onMarkDayOff,
}: {
  row: CalendarBodyRow;
  daysWidth: number;
  editable: boolean;
  onOpenShift: (t: ShiftEditTarget) => void;
  onLongPressShift: (t: ShiftEditTarget) => void;
  onMarkDayOff: (t: ShiftEditTarget) => void;
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
          <CalendarCellView
            cell={cell}
            editable={editable}
            onOpenShift={onOpenShift}
            onLongPressShift={onLongPressShift}
            onMarkDayOff={onMarkDayOff}
          />
        </View>
      ))}
    </View>
  );
});

const CalendarCellView = memo(function CalendarCellView({
  cell,
  editable,
  onOpenShift,
  onLongPressShift,
  onMarkDayOff,
}: {
  cell: CalendarCell;
  editable: boolean;
  onOpenShift: (t: ShiftEditTarget) => void;
  onLongPressShift: (t: ShiftEditTarget) => void;
  onMarkDayOff: (t: ShiftEditTarget) => void;
}) {
  const { t } = useI18n();
  const dayOffLbl = t('schedule.dayOffLabel');
  const breakDisplay = (raw: string) =>
    displayBreakAnnotation(raw, {
      noBreak: t('schedule.noBreak'),
      breakTime: t('schedule.breakTime'),
      office: t('schedule.office'),
    });
  const otherStoreBadge = (label: string, onShift?: boolean) => (
    <View style={[styles.otherStorePill, onShift && styles.otherStorePillOnShift]}>
      <Text style={styles.otherStorePillText} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
  if (cell.kind === 'empty') {
    const target: ShiftEditTarget = {
      role: cell.role,
      trIdx: cell.trIdx,
      dayStr: cell.dayStr,
    };
    const pill = pillForRole(cell.role);
    const emptyStyle = [
      styles.cellInnerEmpty,
      {
        backgroundColor: pill.bg,
        borderColor: pill.border,
        borderLeftColor: pill.fg,
      },
    ];
    const body = cell.otherStoreLabel ? (
      otherStoreBadge(cell.otherStoreLabel)
    ) : (
      <Text style={styles.dayoffSmall}>{dayOffLbl}</Text>
    );
    if (!editable) return <View style={emptyStyle}>{body}</View>;
    return (
      <Pressable
        style={emptyStyle}
        onPress={() => onOpenShift(target)}
        onLongPress={() => onLongPressShift(target)}
        delayLongPress={350}
      >
        {body}
      </Pressable>
    );
  }
  if (cell.kind === 'dayoff') {
    const target: ShiftEditTarget = {
      role: cell.role,
      trIdx: cell.trIdx,
      dayStr: cell.dayStr,
    };
    const pill = pillForRole(cell.role);
    const emptyStyle = [
      styles.cellInnerEmpty,
      styles.cellInnerEmptyTimed,
      {
        backgroundColor: pill.bg,
        borderColor: pill.border,
        borderLeftColor: pill.fg,
      },
    ];
    const body = (
      <>
        <View style={styles.dayoffTimeBlock}>
          <Text style={styles.slotTimeMuted}>{cell.timeLabel}</Text>
        </View>
        {cell.otherStoreLabel ? (
          otherStoreBadge(cell.otherStoreLabel)
        ) : (
          <Text style={styles.dayoffLabel}>{dayOffLbl}</Text>
        )}
      </>
    );
    if (!editable) return <View style={emptyStyle}>{body}</View>;
    return (
      <Pressable
        style={emptyStyle}
        onPress={() => onOpenShift(target)}
        onLongPress={() => onLongPressShift(target)}
        delayLongPress={350}
      >
        {body}
      </Pressable>
    );
  }
  const target: ShiftEditTarget = {
    role: cell.shift.role,
    trIdx: cell.shift.trIdx,
    dayStr: cell.shift.day,
    shift: cell.shift,
  };
  const rd = ROLE_PILL[cell.shift.roleClass] || ROLE_PILL['role-kitchen'];
  const filledStyle = [
    styles.cellInner,
    {
      backgroundColor: rd.bg,
      borderColor: rd.border,
      borderLeftColor: rd.fg,
    },
  ];
  const filledBody = (
    <>
      <Text style={styles.slotTime}>{cell.timeLabel}</Text>
      {cell.breakText ? (
        <Text style={styles.slotBreak}>{breakDisplay(cell.breakText)}</Text>
      ) : null}
      {cell.hours ? <Text style={styles.slotHours}>{cell.hours}</Text> : null}
      {cell.otherStoreLabel ? otherStoreBadge(cell.otherStoreLabel, true) : null}
    </>
  );
  if (!editable) return <View style={filledStyle}>{filledBody}</View>;
  return (
    <View style={filledStyle}>
      <Pressable
        style={styles.cellDayOffBtn}
        onPress={() => onMarkDayOff(target)}
        accessibilityRole="button"
        accessibilityLabel={t('schedule.markDayOff')}
        hitSlop={4}
      >
        <Text style={styles.cellDayOffBtnText}>×</Text>
      </Pressable>
      <Pressable
        onPress={() => onOpenShift(target)}
        onLongPress={() => onLongPressShift(target)}
        delayLongPress={350}
        accessibilityRole="button"
        accessibilityLabel={t('common.edit')}
      >
        {filledBody}
      </Pressable>
    </View>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, minHeight: 0, backgroundColor: '#f8fafc' },
  chrome: { flexShrink: 0, backgroundColor: '#f8fafc' },
  gridScroll: { flex: 1, minHeight: 0 },
  gridScrollContent: { flexGrow: 1, paddingBottom: 12 },
  brandRow: { paddingHorizontal: 12, paddingTop: 4, paddingBottom: 2 },
  brandLogo: { width: 52, height: 52, resizeMode: 'contain' },
  toolbar: { paddingHorizontal: 12, paddingTop: 8 },
  toolbarActions: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginTop: 10, gap: 8 },
  publishBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#c41230',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  publishBtnDisabled: { opacity: 0.6 },
  publishBtnText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  undoBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 8,
  },
  undoBtnDisabled: { opacity: 0.45 },
  undoBtnText: { color: '#334155', fontWeight: '700', fontSize: 14 },
  undoBtnTextDisabled: { color: '#94a3b8' },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  historyMeta: { fontSize: 11, color: '#94a3b8', textTransform: 'uppercase' },
  historyRevertBtn: {
    backgroundColor: '#0f172a',
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
  },
  historyRevertBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  locRow: { paddingHorizontal: 12, marginTop: 6 },
  locRowContent: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  locChipsScroll: { flex: 1 },
  locActions: { flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0 },
  viewOnlyHint: {
    marginHorizontal: 12,
    marginTop: 6,
    fontSize: 13,
    color: '#92400e',
    backgroundColor: '#fffbeb',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    overflow: 'hidden',
  },
  copyBanner: {
    marginHorizontal: 12,
    marginTop: 6,
    borderRadius: 8,
    backgroundColor: '#eff6ff',
    borderWidth: 1,
    borderColor: '#bfdbfe',
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  copyBannerText: { flex: 1, fontSize: 13, color: '#1e40af', fontWeight: '600' },
  copyBannerCancel: { fontSize: 13, color: '#c41230', fontWeight: '700' },
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
  matrix: { paddingLeft: 4, paddingBottom: 16, alignSelf: 'stretch', width: '100%' },
  matrixInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  personCol: {
    flexShrink: 0,
    backgroundColor: '#f8fafc',
  },
  sectionMatrixRow: {
    marginBottom: SECTION_GAP_BELOW,
  },
  dataMatrixRow: {
    borderBottomWidth: 1,
    borderColor: '#eef2f7',
    backgroundColor: '#fff',
    minHeight: DATA_ROW_MIN_H,
  },
  personTh: {
    height: HEADER_ROW_H,
    paddingVertical: 10,
    paddingHorizontal: 6,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'flex-end',
    backgroundColor: '#fff',
  },
  headerDays: {
    flexDirection: 'row',
    height: HEADER_ROW_H,
  },
  personSection: {
    minHeight: SECTION_ROW_H,
    height: SECTION_ROW_H,
    paddingHorizontal: 6,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderLeftWidth: 3,
    borderColor: '#e8eaef',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  sectionDayFill: {
    height: SECTION_ROW_H,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: '#e8eaef',
  },
  personCell: {
    padding: 6,
    backgroundColor: '#fff',
    justifyContent: 'center',
  },
  personRowTop: {
    flexDirection: 'row',
    /* Center — avoid stretching the name control taller than its content box. */
    alignItems: 'center',
    gap: 4,
  },
  personSelect: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    backgroundColor: '#fff',
    paddingVertical: 8,
    paddingHorizontal: 8,
    /* Match reorder column (~22+2+22) so the control border isn’t short/clipped-looking. */
    minHeight: 46,
    justifyContent: 'center',
  },
  personSelectText: { fontSize: 12, fontWeight: '600', color: '#0f172a' },
  awayPrimaryBadge: {
    marginTop: 2,
    fontSize: 10,
    fontWeight: '600',
    color: '#b45309',
  },
  reorderCol: {
    justifyContent: 'space-between',
    gap: 2,
  },
  reorderBtn: {
    width: 28,
    height: 22,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reorderBtnDisabled: {
    opacity: 0.35,
  },
  reorderBtnText: { fontSize: 12, fontWeight: '700', color: '#475569', lineHeight: 14 },
  addSlotBtn: {
    marginTop: 4,
    alignSelf: 'flex-start',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  addSlotBtnText: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  deleteSlotBtn: {
    marginTop: 4,
    paddingVertical: 4,
    alignItems: 'center',
    borderRadius: 4,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  deleteSlotBtnText: { fontSize: 10, fontWeight: '700', color: '#64748b' },
  th: {
    height: HEADER_ROW_H,
    paddingVertical: 10,
    paddingHorizontal: 4,
    borderBottomWidth: 1,
    borderColor: '#e2e8f0',
    justifyContent: 'flex-end',
  },
  thFull: { fontSize: 11, fontWeight: '800', color: '#0f172a', letterSpacing: 0.6 },
  thSub: { marginTop: 4, fontSize: 11, color: '#64748b', fontWeight: '500' },
  sectionText: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.5,
    lineHeight: 13,
    textTransform: 'uppercase',
  },
  dataDays: {
    flexDirection: 'row',
    minHeight: DATA_ROW_MIN_H,
    alignItems: 'stretch',
  },
  sideTotals: {
    flexShrink: 0,
    paddingHorizontal: 4,
    borderLeftWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
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
    minHeight: DATA_ROW_MIN_H,
  },
  groupOrderInput: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 6,
    backgroundColor: '#fff',
    paddingVertical: 7,
    paddingHorizontal: 6,
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
  },
  groupOrderReadonly: {
    fontSize: 12,
    fontWeight: '600',
    color: '#0f172a',
    textAlign: 'center',
    paddingVertical: 7,
    paddingHorizontal: 6,
  },
  personTotalsCell: {
    minHeight: DATA_ROW_MIN_H,
    paddingHorizontal: 4,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef2f7',
    justifyContent: 'center',
    gap: 1,
  },
  sideTotalsTitle: {
    fontSize: 10,
    fontWeight: '800',
    color: '#475569',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sideTotalsGross: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  sideTotalsNet: { fontSize: 11, fontWeight: '700', color: '#0f766e', marginTop: 4 },
  sideTotalsTag: { fontSize: 10, fontWeight: '500', color: '#64748b' },
  cell: { minHeight: DATA_ROW_MIN_H, borderRightWidth: 1, borderColor: '#f1f5f9', padding: 4 },
  cellInner: {
    flex: 1,
    borderWidth: 1,
    borderLeftWidth: 3,
    borderRadius: 6,
    paddingVertical: 6,
    paddingHorizontal: 6,
    position: 'relative',
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
  slotTime: { fontSize: 12, fontWeight: '700', color: '#0f172a' },
  slotTimeMuted: { fontSize: 12, fontWeight: '600', color: '#64748b' },
  dayoffTimeBlock: {
    marginBottom: 4,
    paddingBottom: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#cbd5e1',
  },
  slotBreak: { fontSize: 10, color: '#64748b', marginTop: 2 },
  slotHours: { fontSize: 11, fontWeight: '700', color: '#334155', marginTop: 1 },
  cellDayOffBtn: {
    position: 'absolute',
    top: 2,
    right: 2,
    zIndex: 2,
    width: 22,
    height: 22,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.75)',
  },
  cellDayOffBtnText: { fontSize: 16, fontWeight: '700', color: '#94a3b8', lineHeight: 18 },
  dayoffLabel: { fontSize: 11, fontWeight: '700', color: '#94a3b8', marginTop: 6 },
  dayoffSmall: { fontSize: 11, fontWeight: '700', color: '#cbd5e1', textAlign: 'center' },
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
  otherStorePillOnShift: {
    marginTop: 3,
  },
  otherStorePillText: {
    fontSize: 10,
    fontWeight: '700',
    color: '#9a3412',
    textAlign: 'center',
  },
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
  modalPanelTall: { maxHeight: '78%' },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  modalSub: { fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 12 },
  modalList: { maxHeight: 280 },
  modalRow: { paddingVertical: 14, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  modalRowText: { fontSize: 16, color: '#0f172a' },
  modalRowMeta: { fontSize: 12, color: '#64748b', marginTop: 2 },
  modalCancel: { marginTop: 12, paddingVertical: 12, alignItems: 'center' },
  modalCancelText: { fontSize: 16, color: '#c41230', fontWeight: '700' },
  editRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  editLabel: { fontSize: 15, fontWeight: '600', color: '#0f172a' },
  editTimesRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginBottom: 12,
    flexWrap: 'wrap',
  },
  editField: { minWidth: 88, flexGrow: 1, flexBasis: 88 },
  editFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 4,
    minHeight: 28,
    lineHeight: 14,
  },
  editInput: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 10,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#fff',
    minWidth: 88,
    height: 44,
  },
  editInputLocked: {
    backgroundColor: '#f1f5f9',
    color: '#64748b',
  },
  editSep: {
    fontSize: 16,
    color: '#94a3b8',
    height: 44,
    lineHeight: 44,
    paddingBottom: 0,
    alignSelf: 'flex-end',
  },
  editHours: {
    fontSize: 13,
    color: '#64748b',
    height: 44,
    lineHeight: 44,
    fontWeight: '600',
    alignSelf: 'flex-end',
  },
  chipWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  editChip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#fff',
  },
  editChipActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  editChipText: { fontSize: 12, fontWeight: '600', color: '#334155' },
  editChipTextActive: { color: '#c41230' },
  saveBtn: {
    marginTop: 16,
    backgroundColor: '#c41230',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  saveBtnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
