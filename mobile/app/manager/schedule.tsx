import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  employeeDisplayName,
  normalizeEmployeeStaffType,
  managerCanEditRestaurant,
  managerManagedRestaurantId,
  type EmployeeRow,
} from '../../lib/employees';
import { readStoredTeamStateId } from '../../lib/companySession';
import { useI18n } from '../../contexts/LocaleContext';
import { portalNotifySchedulePublished } from '../../lib/portalAuth';
import { isManagerLikeRole } from '../../lib/roles';
import { formatScheduleWeekRangeLabel } from '../../lib/schedule/employeeShiftDisplay';
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
  buildSchedule,
  buildWeeksFromMonday,
  compactAssignmentsAfterDraftSlotDeletes,
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
  normalizeBreakAnnotationTime,
  normalizeSchedulePublishedMap,
  orderedScheduleSlotIndicesForRole,
  parseBreakAnnotation,
  patchDraftScheduleForWeek,
  purgeDefaultUnassignedRestaurantAssignments,
  redPokeShiftHoursDecimal,
  SCHEDULE_TEMPLATE_WEEK_INDEX,
  SCHEDULE_VIEW_WEEK_COUNT,
  schedulePublishedPayload,
  scheduleRowPrimaryPerson,
  seedDefaultPublishedWeeks,
  slotCountForRole,
  STAFF_TYPE_LABELS,
  assignmentShell,
  WEEKDAY_KEYS,
  weekdayKeyFromScheduleDay,
  type BreakAnnotationType,
  type CalendarBodyRow,
  type CalendarCell,
} from '../../lib/schedule/engine';
import {
  getCustomSlotOrderForRole,
  mergePendingDraftWithHydrated,
  moveTrIdxInSlotOrder,
  patchSlotOrderAfterAdd,
  patchSlotOrderAfterDelete,
  patchSlotOrderInDraftSchedule,
  readSlotOrderByRestaurantForWeek,
} from '../../lib/schedule/slotOrder';

/** Wide enough for a single-line slot time (e.g. 10:00 AM – 7:30 PM) in the cell header. */
const CELL_MIN = 158;
/** Sticky Person column — parity with web `.calendar-row-person-col`. */
const PERSON_COL = 132;
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

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: (normalizeEmployeeStaffType(e.staffType) || e.staffType) as RoleKey,
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
  const { t, staffTypeLabel } = useI18n();
  const { employees, teamState, refetch, loading, applyLocalScheduleAssignments, myEmployee } = useAppData();
  const [weekIndex, setWeekIndex] = useState(SCHEDULE_TEMPLATE_WEEK_INDEX);
  const [restaurants] = useState<Restaurant[]>(() => defaultRestaurants());
  const [currentRestaurantId, setCurrentRestaurantId] = useState(restaurants[0]?.id ?? 'rp-9');
  const scheduleEditable = managerCanEditRestaurant(myEmployee, currentRestaurantId, role);

  useEffect(() => {
    const scope = managerManagedRestaurantId(myEmployee, role);
    if (scope === 'rp-8' || scope === 'rp-9') {
      setCurrentRestaurantId(scope);
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
  const [rowPersonPicker, setRowPersonPicker] = useState<RowPersonTarget | null>(null);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [undoDepth, setUndoDepth] = useState(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keeps a pending draft payload across debounced assignment saves (e.g. Monday window roll). */
  const pendingDraftRef = useRef<unknown>(undefined);
  const pendingStoreRef = useRef<AssignmentStore | null>(null);
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
            Alert.alert(
              t('schedule.published'),
              t('schedule.publishedNotified', {
                count: notify.sent,
                s: notify.sent === 1 ? '' : 's',
              }) + failNote
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

  const persistCloud = useCallback(
    async (store: AssignmentStore, draftSchedule?: unknown) => {
      if (!supabase || !isManagerLikeRole(role)) return;
      setSaving(true);
      try {
        const toSave = JSON.parse(JSON.stringify(store)) as AssignmentStore;
        purgeDefaultUnassignedRestaurantAssignments(toSave, restaurants);
        const teamStateId = await readStoredTeamStateId();
        const draftToSave =
          draftSchedule !== undefined ? draftSchedule : pendingDraftRef.current;
        const payload: Record<string, unknown> = {
          id: teamStateId,
          schedule_assignments: toSave,
        };
        const fields = ['schedule_assignments'];
        if (draftToSave !== undefined) {
          payload.draft_schedule = draftToSave;
          fields.push('draft_schedule');
        }
        const up = await supabase.from('team_state').upsert(payload, { onConflict: 'id' });
        if (up.error) console.warn('team_state upsert', up.error);
        else {
          pendingDraftRef.current = undefined;
          await broadcastTeamStateChanged(
            supabase,
            teamStateId,
            fields,
            session?.user?.id
          );
          // Local state already has assignments; avoid full hydrate after every edit.
          suppressHydrateUndoClearRef.current = true;
          applyLocalScheduleAssignments(toSave, draftToSave);
        }
      } finally {
        setSaving(false);
      }
    },
    [role, restaurants, session?.user?.id, applyLocalScheduleAssignments]
  );

  const queuePersist = useCallback(
    (store: AssignmentStore, draftSchedule?: unknown) => {
      pendingStoreRef.current = store;
      if (draftSchedule !== undefined) pendingDraftRef.current = draftSchedule;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        const latestStore = pendingStoreRef.current;
        if (!latestStore) return;
        void persistCloud(latestStore, pendingDraftRef.current);
      }, 3000);
    },
    [persistCloud]
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

  useEffect(() => {
    const pendingDraft = pendingDraftRef.current;
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
    setAssignmentStore(rolled.store);
    setRolledDraftRaw(draftOut);
    if (rolled.changed && isManagerLikeRole(role)) {
      /* Local commits (incl. delete-slot) update teamState and re-enter here — do not wipe Undo. */
      if (!suppressHydrateUndoClearRef.current) clearUndoStack();
      applyLocalScheduleAssignments(rolled.store, draftOut);
      queuePersist(rolled.store, draftOut);
    }
    suppressHydrateUndoClearRef.current = false;
  }, [teamState, restaurants, role, queuePersist, applyLocalScheduleAssignments, clearUndoStack]);

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
    () =>
      buildCalendarBody(
        schedule,
        visibleDays,
        draftRows,
        lites,
        currentRestaurantId,
        slotOrderByRestaurant
      ),
    [schedule, visibleDays, draftRows, lites, currentRestaurantId, slotOrderByRestaurant]
  );

  /** Display position within role section → enable ↑/↓. */
  const slotMoveFlags = useMemo(() => {
    const flags = new Map<string, { up: boolean; down: boolean }>();
    (['Bartender', 'Kitchen', 'Server'] as RoleKey[]).forEach((roleKey) => {
      const slotN = slotCountForRole(draftRows, roleKey);
      const order = orderedScheduleSlotIndicesForRole(
        schedule,
        roleKey,
        slotN,
        visibleDays,
        lites,
        currentRestaurantId,
        slotOrderByRestaurant
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
  ]);

  const daysWidth = Math.max(
    Dimensions.get('window').width - PERSON_COL - 16,
    visibleDays.length * CELL_MIN
  );

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
    requestAnimationFrame(() => {
      outerScrollRef.current?.scrollTo({ y: saved.y, animated: false });
      dayScrollRef.current?.scrollTo({ x: saved.x, animated: false });
    });
  }

  function openShiftEditor(target: ShiftEditTarget) {
    if (!scheduleEditable) return;
    captureScheduleScroll();
    const wk = weekdayKeyFromScheduleDay(target.dayStr);
    const di = WEEKDAY_KEYS.indexOf(wk);
    if (target.shift) {
      const parsed = parseBreakAnnotation(target.shift.redPokeBreak || '');
      setEditDayOff(false);
      setEditStart(target.shift.start || '10:00');
      setEditEnd(target.shift.end || '18:00');
      setEditBreakType(parsed.type);
      setEditBreakTime(breakAnnotationTimeToHHMM(parsed.time || '3:00PM') || '15:00');
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

  function applyShiftDetailsSave() {
    if (!shiftEditor || !isManagerLikeRole(role) || !scheduleEditable) return;
    const wk = weekdayKeyFromScheduleDay(shiftEditor.dayStr);
    const di = WEEKDAY_KEYS.indexOf(wk);
    if (di < 0) return;
    if (!editDayOff) {
      if (!/^\d{1,2}:\d{2}$/.test(editStart.trim()) || !/^\d{1,2}:\d{2}$/.test(editEnd.trim())) {
        Alert.alert(t('schedule.invalidTime'), t('schedule.invalidTimeHint'));
        return;
      }
      if (editBreakType !== 'NO BREAK' && !normalizeBreakAnnotationTime(editBreakTime)) {
        Alert.alert(t('schedule.invalidBreakTime'), t('schedule.invalidBreakHint'));
        return;
      }
    }
    const breakText = formatBreakAnnotation(
      normalizeBreakAnnotationTime(editBreakTime) || '3:00PM',
      editBreakType
    );
    const list =
      editWorker === 'Unassigned' ? ['Unassigned'] : [editWorker].filter(Boolean);
    const applied = applyShiftSlotEdit({
      draftRows,
      store: assignmentStoreRef.current,
      restaurantId: currentRestaurantId,
      weekIndex,
      role: shiftEditor.role,
      trIdx: shiftEditor.trIdx,
      dayInWeek: di,
      start: editStart,
      end: editEnd,
      isDayOff: editDayOff,
      breakText,
      workers: editDayOff ? null : list,
    });
    if (!applied) {
      Alert.alert(t('schedule.couldNotSave'), t('schedule.checkTimes'));
      return;
    }
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
    setShiftEditor(null);
    restoreScheduleScroll();
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
    const slotN = slotCountForRole(draftRows, roleKey);
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
        null
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

  function applyRowPersonChoice(target: RowPersonTarget, workerName: string) {
    if (!scheduleEditable) return;
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
      setRowPersonPicker(null);
      return;
    }
    pushUndoSnapshot();
    suppressHydrateUndoClearRef.current = true;
    setAssignmentStore(next);
    applyLocalScheduleAssignments(next);
    queuePersist(next);
    setRowPersonPicker(null);
  }

  const rowPickerNames = useMemo(() => {
    if (!rowPersonPicker) return [] as string[];
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
    if (selected && selected !== 'Unassigned') {
      const selKey = selected.trim().toLowerCase();
      const inPool = pool.some((n) => n.trim().toLowerCase() === selKey);
      if (!inPool) return ['Unassigned', selected, ...pool];
    }
    return ['Unassigned', ...pool];
  }, [rowPersonPicker, schedule, visibleDays, lites, currentRestaurantId, assignmentStore, weekIndex]);

  const shiftPickerNames = useMemo(() => {
    if (!shiftEditor) return [] as string[];
    const names = employees
      .filter((e) => {
        const st = normalizeEmployeeStaffType(e.staffType) || e.staffType;
        if (st !== shiftEditor.role) return false;
        const u = e.usualRestaurant || 'both';
        if (u === 'both') return true;
        return u === currentRestaurantId;
      })
      .map(employeeDisplayName)
      .filter(Boolean);
    return ['Unassigned', ...names];
  }, [shiftEditor, employees, currentRestaurantId]);

  const editHoursLabel = useMemo(() => {
    if (editDayOff) return '';
    if (!/^\d{1,2}:\d{2}$/.test(editStart) || !/^\d{1,2}:\d{2}$/.test(editEnd)) return '';
    return `${redPokeShiftHoursDecimal(editStart, editEnd)} h`;
  }, [editDayOff, editStart, editEnd]);

  const modalOpen = !!shiftEditor || !!rowPersonPicker;

  return (
    <View style={[styles.screen, { paddingBottom: insets.bottom }]}>
      <ScrollView
        ref={outerScrollRef}
        style={styles.outerScroll}
        contentContainerStyle={styles.outerScrollContent}
        nestedScrollEnabled
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator
        onScroll={(e) => {
          outerScrollYRef.current = e.nativeEvent.contentOffset.y;
        }}
        scrollEventThrottle={16}
      >
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

        {/*
          Sticky Person column + ONE horizontal ScrollView for all day columns.
          Avoids N-scroll sync (programmatic scrollTo + onScroll) which fights
          the user gesture and causes horizontal flicker.
        */}
        <View style={styles.matrix}>
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
                    onOpenRowPerson={setRowPersonPicker}
                    onAddSlot={addSlotForRole}
                    onDeleteSlot={deleteSlotForRole}
                    onMoveRow={moveScheduleRow}
                    canMoveUp={!!move?.up}
                    canMoveDown={!!move?.down}
                  />
                );
              })}
            </View>

            <ScrollView
              ref={dayScrollRef}
              horizontal
              nestedScrollEnabled
              showsHorizontalScrollIndicator
              style={styles.dayLane}
              contentContainerStyle={styles.dayLaneContent}
              keyboardShouldPersistTaps="handled"
              onScroll={(e) => {
                dayScrollXRef.current = e.nativeEvent.contentOffset.x;
              }}
              scrollEventThrottle={16}
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
                  <DayColRow
                    key={`d-${ri}`}
                    row={row}
                    daysWidth={daysWidth}
                    editable={scheduleEditable}
                    onOpenShift={openShiftEditor}
                  />
                ))}
              </View>
            </ScrollView>
          </View>
        </View>
      </ScrollView>

      <Modal visible={modalOpen} animationType="slide" transparent>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => {
            setShiftEditor(null);
            setRowPersonPicker(null);
            restoreScheduleScroll();
          }}
        >
          <Pressable style={[styles.modalPanel, shiftEditor && styles.modalPanelTall]} onPress={(e) => e.stopPropagation()}>
            {rowPersonPicker ? (
              <>
                <Text style={styles.modalTitle}>{t('schedule.assignRowPerson')}</Text>
                <Text style={styles.modalSub} numberOfLines={3}>
                  {t('schedule.assignRowSub', {
                    role: staffTypeLabel(rowPersonPicker.role),
                    n: rowPersonPicker.trIdx + 1,
                  })}
                </Text>
                <FlatList
                  data={rowPickerNames}
                  keyExtractor={(item) => item}
                  style={styles.modalList}
                  renderItem={({ item }) => (
                    <Pressable
                      style={styles.modalRow}
                      onPress={() => applyRowPersonChoice(rowPersonPicker, item)}
                    >
                      <Text style={styles.modalRowText}>{item}</Text>
                    </Pressable>
                  )}
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
                          style={styles.editInput}
                          value={editStart}
                          onChangeText={setEditStart}
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
                      {BREAK_ANNOTATION_TYPE_PRESETS.map((t) => (
                        <Pressable
                          key={t}
                          onPress={() => setEditBreakType(t)}
                          style={[styles.editChip, editBreakType === t && styles.editChipActive]}
                        >
                          <Text
                            style={[
                              styles.editChipText,
                              editBreakType === t && styles.editChipTextActive,
                            ]}
                          >
                            {t}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                    {editBreakType !== 'NO BREAK' ? (
                      <View style={[styles.editField, { marginTop: 10 }]}>
                        <Text style={styles.editFieldLabel}>{t('schedule.assignedTime')}</Text>
                        <TextInput
                          style={styles.editInput}
                          value={editBreakTime}
                          onChangeText={setEditBreakTime}
                          placeholder="15:00"
                          autoCapitalize="none"
                          autoCorrect={false}
                        />
                      </View>
                    ) : null}
                    <Text style={[styles.editFieldLabel, { marginTop: 12 }]}>{t('common.person')}</Text>
                    <View style={styles.chipWrap}>
                      {shiftPickerNames.slice(0, 12).map((name) => (
                        <Pressable
                          key={name}
                          onPress={() => setEditWorker(name)}
                          style={[styles.editChip, editWorker === name && styles.editChipActive]}
                        >
                          <Text
                            style={[
                              styles.editChipText,
                              editWorker === name && styles.editChipTextActive,
                            ]}
                          >
                            {name}
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
  if (row.kind === 'section') {
    const bg = sectionBg(row.variant);
    const fg = sectionFg(row.variant);
    const addRole: RoleKey =
      row.variant === 'foh' ? 'Bartender' : row.variant === 'delivery' ? 'Server' : 'Kitchen';
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
          {row.title}
        </Text>
        {editable ? (
          <Pressable
            onPress={() => onAddSlot(addRole)}
            style={styles.addSlotBtn}
            accessibilityRole="button"
            accessibilityLabel={`Add slot for ${row.title}`}
          >
            <Text style={styles.addSlotBtnText}>Add slot</Text>
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
  const label = selected && selected !== 'Unassigned' ? selected : 'Unassigned';

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
          </Pressable>
        ) : (
          <View style={styles.personSelect}>
            <Text style={styles.personSelectText} numberOfLines={1} ellipsizeMode="tail">
              {label}
            </Text>
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
          accessibilityLabel={`Delete slot ${row.trIdx + 1}`}
        >
          <Text style={styles.deleteSlotBtnText}>Delete slot</Text>
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
}: {
  row: CalendarBodyRow;
  daysWidth: number;
  editable: boolean;
  onOpenShift: (t: ShiftEditTarget) => void;
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
          <CalendarCellView cell={cell} editable={editable} onOpenShift={onOpenShift} />
        </View>
      ))}
    </View>
  );
});

const CalendarCellView = memo(function CalendarCellView({
  cell,
  editable,
  onOpenShift,
}: {
  cell: CalendarCell;
  editable: boolean;
  onOpenShift: (t: ShiftEditTarget) => void;
}) {
  if (cell.kind === 'empty') {
    const body = <Text style={styles.dayoffSmall}>DAY-OFF</Text>;
    if (!editable) return <View style={styles.cellInnerMuted}>{body}</View>;
    return (
      <Pressable
        style={styles.cellInnerMuted}
        onPress={() =>
          onOpenShift({ role: cell.role, trIdx: cell.trIdx, dayStr: cell.dayStr })
        }
      >
        {body}
      </Pressable>
    );
  }
  if (cell.kind === 'dayoff') {
    const body = (
      <>
        <Text style={styles.slotTime}>{cell.timeLabel}</Text>
        <Text style={styles.dayoffLabel}>DAY-OFF</Text>
      </>
    );
    if (!editable) return <View style={styles.cellInnerMuted}>{body}</View>;
    return (
      <Pressable
        style={styles.cellInnerMuted}
        onPress={() =>
          onOpenShift({ role: cell.role, trIdx: cell.trIdx, dayStr: cell.dayStr })
        }
      >
        {body}
      </Pressable>
    );
  }
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
      {cell.breakText ? <Text style={styles.slotBreak}>{cell.breakText}</Text> : null}
      <Text style={styles.slotHours}>{cell.hours}h</Text>
    </>
  );
  if (!editable) return <View style={filledStyle}>{filledBody}</View>;
  return (
    <Pressable
      style={filledStyle}
      onPress={() =>
        onOpenShift({
          role: cell.shift.role,
          trIdx: cell.shift.trIdx,
          dayStr: cell.shift.day,
          shift: cell.shift,
        })
      }
    >
      {filledBody}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  outerScroll: { flex: 1 },
  outerScrollContent: { flexGrow: 1, paddingBottom: 12 },
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
  matrix: { paddingLeft: 4, paddingBottom: 16 },
  matrixInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  personCol: {
    flexShrink: 0,
    zIndex: 1,
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
  dayLane: {
    flex: 1,
  },
  dayLaneContent: {
    flexGrow: 1,
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
  },
  dataDays: {
    flexDirection: 'row',
    minHeight: DATA_ROW_MIN_H,
    alignItems: 'stretch',
  },
  cell: { minHeight: DATA_ROW_MIN_H, borderRightWidth: 1, borderColor: '#f1f5f9', padding: 4 },
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
  modalPanelTall: { maxHeight: '78%' },
  modalTitle: { fontSize: 18, fontWeight: '800', color: '#0f172a' },
  modalSub: { fontSize: 14, color: '#64748b', marginTop: 6, marginBottom: 12 },
  modalList: { maxHeight: 280 },
  modalRow: { paddingVertical: 14, borderBottomWidth: 1, borderColor: '#f1f5f9' },
  modalRowText: { fontSize: 16, color: '#0f172a' },
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
  editField: { minWidth: 88 },
  editFieldLabel: {
    fontSize: 11,
    fontWeight: '700',
    color: '#64748b',
    textTransform: 'uppercase',
    marginBottom: 4,
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
  },
  editSep: { fontSize: 16, color: '#94a3b8', paddingBottom: 12 },
  editHours: { fontSize: 13, color: '#64748b', paddingBottom: 12, fontWeight: '600' },
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
