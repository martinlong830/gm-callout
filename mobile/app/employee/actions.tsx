import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, type ErrorBoundaryProps } from 'expo-router';
import { CompactShiftRow } from '../../components/CompactShiftRow';
import { DatePickerField } from '../../components/DatePickerField';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { employeeDisplayName } from '../../lib/employees';
import {
  compactShiftTimeLabel,
  currentScheduleWeekIndex,
  formatCalendarDateLabel,
  shiftsForWeekIndex,
  shiftOptionKey,
  uniqueWeekIndicesWithShifts,
  weekIndexFromIso,
} from '../../lib/schedule/employeeShiftDisplay';
import {
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  getWorkerScheduleBuckets,
  hydrateScheduleAssignmentsFromTeamState,
  SCHEDULE_VIEW_WEEK_COUNT,
  type WorkerShiftRow,
} from '../../lib/schedule/engine';
import type { EmployeeLite, RoleKey } from '../../lib/schedule/types';
import { formatStaffRequestSubmittedDate, insertStaffRequest } from '../../lib/staffRequests';
import {
  coworkerSwapTargets,
  offerVisibleToWorker,
  swapRequestDisplayStatus,
} from '../../lib/shiftSwap';
import { supabase } from '../../lib/supabase';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

type FormKey = 'timeoff' | 'swap' | 'callout';

function toLite(e: { firstName: string; lastName: string; staffType: string; usualRestaurant: string }): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    staffType: e.staffType as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function formatShiftRequestLabel(row: WorkerShiftRow): string {
  return `${formatCalendarDateLabel(row)} · ${compactShiftTimeLabel(row)} · ${row.restaurantName}`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const CHIPS: { key: FormKey; labelKey: string }[] = [
  { key: 'timeoff', labelKey: 'actions.timeOff' },
  { key: 'swap', labelKey: 'actions.shiftSwaps' },
  { key: 'callout', labelKey: 'actions.callouts' },
];

export default function EmployeeActions() {
  const { displayName } = useAuth();
  const { t, statusLabel } = useI18n();
  const { myEmployee, employees, staffRequests, teamState, refetch } = useAppData();
  const params = useLocalSearchParams<{ subsection?: string; requestId?: string }>();
  const roleCode = myEmployee?.staffType ?? 'Kitchen';
  const nameForRequests = myEmployee ? employeeDisplayName(myEmployee) : displayName;

  const [activeForm, setActiveForm] = useState<FormKey>('timeoff');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = String(params.subsection || '')
      .trim()
      .toLowerCase();
    if (raw === 'timeoff' || raw === 'swap' || raw === 'callout' || raw === 'callout_request') {
      setActiveForm(raw === 'callout_request' ? 'callout' : (raw as FormKey));
    }
  }, [params.subsection]);

  const focusRequestId = String(params.requestId || '').trim();

  const restaurants = useMemo(() => defaultRestaurants(), []);
  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getScheduleAnchorMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const hydrated = useMemo(
    () =>
      hydrateScheduleAssignmentsFromTeamState(
        teamState?.schedule_assignments,
        restaurants,
        teamState?.draft_schedule
      ),
    [teamState?.schedule_assignments, teamState?.draft_schedule, restaurants]
  );
  const assignmentStore = hydrated.store;
  const draftScheduleRaw = hydrated.draftSchedule ?? teamState?.draft_schedule;
  const lites = useMemo(() => employees.map(toLite), [employees]);

  const workerShifts = useMemo(() => {
    if (!nameForRequests.trim()) return [] as WorkerShiftRow[];
    const { today, upcoming } = getWorkerScheduleBuckets({
      workerName: nameForRequests,
      weekMeta,
      allWeekDays,
      draftScheduleRaw,
      employees: lites,
      restaurants,
      assignmentStore,
      schedulePublishedRaw: teamState?.schedule_published,
    });
    return [...today, ...upcoming];
  }, [
    nameForRequests,
    weekMeta,
    allWeekDays,
    draftScheduleRaw,
    teamState?.schedule_published,
    lites,
    restaurants,
    assignmentStore,
  ]);

  const [timeoffStartDate, setTimeoffStartDate] = useState<Date | null>(null);
  const [timeoffEndDate, setTimeoffEndDate] = useState<Date | null>(null);
  const [timeoffLeaveType, setTimeoffLeaveType] = useState<'vacation' | 'sick'>('vacation');
  const [timeoffNote, setTimeoffNote] = useState('');

  const [swapOfferShift, setSwapOfferShift] = useState<WorkerShiftRow | null>(null);
  const [swapNote, setSwapNote] = useState('');
  /** Empty string = everyone; otherwise employee id. */
  const [swapTargetId, setSwapTargetId] = useState('');
  const [swapAcceptId, setSwapAcceptId] = useState<string | null>(null);
  const [swapAcceptNote, setSwapAcceptNote] = useState('');

  const [calloutShift, setCalloutShift] = useState<WorkerShiftRow | null>(null);
  const [calloutReason, setCalloutReason] = useState('');
  const [shiftPickWeekIndex, setShiftPickWeekIndex] = useState(0);

  const shiftPickWeekIndices = useMemo(
    () => uniqueWeekIndicesWithShifts(workerShifts, weekMeta),
    [workerShifts, weekMeta]
  );
  const scheduleCurrentWeekIndex = useMemo(() => currentScheduleWeekIndex(weekMeta), [weekMeta]);
  const shiftsInPickWeek = useMemo(
    () => shiftsForWeekIndex(workerShifts, weekMeta, shiftPickWeekIndex),
    [workerShifts, weekMeta, shiftPickWeekIndex]
  );

  useEffect(() => {
    if (activeForm !== 'swap' && activeForm !== 'callout') return;
    const cur = scheduleCurrentWeekIndex;
    if (shiftPickWeekIndices.includes(cur)) setShiftPickWeekIndex(cur);
    else if (shiftPickWeekIndices.length) setShiftPickWeekIndex(shiftPickWeekIndices[0]);
  }, [activeForm, shiftPickWeekIndices, scheduleCurrentWeekIndex]);

  useEffect(() => {
    if (swapOfferShift && weekIndexFromIso(weekMeta, swapOfferShift.iso) !== shiftPickWeekIndex) {
      setSwapOfferShift(null);
    }
    if (calloutShift && weekIndexFromIso(weekMeta, calloutShift.iso) !== shiftPickWeekIndex) {
      setCalloutShift(null);
    }
  }, [shiftPickWeekIndex, weekMeta, swapOfferShift, calloutShift]);

  const myRequests = useMemo(() => {
    const self = nameForRequests.trim().toLowerCase();
    if (!self) return [];
    return staffRequests
      .filter(
        (r) =>
          r.type !== 'availability' &&
          String(r.employeeName || '')
            .trim()
            .toLowerCase() === self
      )
      .sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')))
      .slice(0, 12);
  }, [staffRequests, nameForRequests]);

  const openSwapOffers = useMemo(() => {
    const self = nameForRequests.trim().toLowerCase();
    return staffRequests.filter(
      (r) =>
        r.type === 'swap' &&
        r.status === 'pending' &&
        !r.swapOfferId &&
        String(r.employeeName || '')
          .trim()
          .toLowerCase() !== self &&
        r.offeredShiftLabel &&
        offerVisibleToWorker(r, nameForRequests, myEmployee?.id)
    );
  }, [staffRequests, nameForRequests, myEmployee?.id]);

  useEffect(() => {
    if (!focusRequestId || activeForm !== 'swap') return;
    const offer = openSwapOffers.find((r) => r.id === focusRequestId);
    if (offer) setSwapAcceptId(offer.id);
  }, [focusRequestId, activeForm, openSwapOffers]);

  const swapCoworkers = useMemo(
    () => coworkerSwapTargets(employees, nameForRequests, myEmployee?.id),
    [employees, nameForRequests, myEmployee?.id]
  );
  const submitTimeoff = useCallback(async () => {
    if (!supabase) {
      Alert.alert(t('common.error'), t('errors.notConfigured'));
      return;
    }
    if (!timeoffStartDate || !timeoffEndDate) {
      Alert.alert(t('actions.timeOff'), t('actions.chooseDates'));
      return;
    }
    const timeoffStart = isoDate(timeoffStartDate);
    const timeoffEnd = isoDate(timeoffEndDate);
    if (timeoffEnd < timeoffStart) {
      Alert.alert(t('actions.timeOff'), t('actions.endBeforeStart'));
      return;
    }
    const typeLabel = timeoffLeaveType === 'sick' ? t('actions.sickLeave') : t('actions.vacationLeave');
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'timeoff',
        employeeName: nameForRequests,
        role: roleCode,
        leaveType: timeoffLeaveType,
        timeoffStart,
        timeoffEnd,
        summary: `${typeLabel}: ${timeoffStart} to ${timeoffEnd}${timeoffNote.trim() ? `. Notes: ${timeoffNote.trim()}` : ''}`,
      });
      if (!res.ok) Alert.alert(t('common.error'), res.message);
      else {
        Alert.alert(t('common.sent'), t('actions.submittedManager'));
        setTimeoffStartDate(null);
        setTimeoffEndDate(null);
        setTimeoffNote('');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, timeoffStartDate, timeoffEndDate, timeoffLeaveType, timeoffNote, nameForRequests, roleCode, refetch]);

  const submitSwapOffer = useCallback(async () => {
    if (!supabase) {
      Alert.alert(t('common.error'), t('errors.notConfigured'));
      return;
    }
    if (!swapOfferShift) {
      Alert.alert(t('actions.shiftSwaps'), t('actions.chooseShiftOffer'));
      return;
    }
    const shiftLabel = formatShiftRequestLabel(swapOfferShift);
    const target = swapTargetId
      ? swapCoworkers.find((c) => c.id === swapTargetId) || null
      : null;
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'swap',
        employeeName: nameForRequests,
        role: roleCode,
        offeredShiftLabel: shiftLabel,
        offeredShift: {
          restaurantId: swapOfferShift.restaurantId,
          shiftId: swapOfferShift.id,
          day: swapOfferShift.day,
          timeLabel: compactShiftTimeLabel(swapOfferShift),
          iso: swapOfferShift.iso,
        },
        swapTargetEmployeeId: target ? target.id : null,
        swapTargetEmployeeName: target ? target.name : null,
        summary:
          'Shift Swap Offer: ' +
          shiftLabel +
          (target ? `. Requested cover: ${target.name}` : '. Send to everyone') +
          (swapNote.trim() ? '. Notes: ' + swapNote.trim() : ''),
      });
      if (!res.ok) Alert.alert(t('common.error'), res.message);
      else {
        Alert.alert(t('common.sent'), t('actions.postedManager'));
        setSwapNote('');
        setSwapTargetId('');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [
    supabase,
    swapOfferShift,
    swapNote,
    swapTargetId,
    swapCoworkers,
    nameForRequests,
    roleCode,
    refetch,
    t,
  ]);

  const submitSwapAccept = useCallback(async () => {
    if (!supabase) {
      Alert.alert(t('common.error'), t('errors.notConfigured'));
      return;
    }
    if (!swapAcceptId) {
      Alert.alert(t('actions.shiftSwaps'), t('actions.chooseOfferAccept'));
      return;
    }
    const offer = openSwapOffers.find((r) => r.id === swapAcceptId);
    const offerLabel = offer
      ? `${offer.offeredShiftLabel} · offered by ${offer.employeeName}`
      : swapAcceptId;
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'swap',
        employeeName: nameForRequests,
        role: roleCode,
        swapOfferId: swapAcceptId,
        offeredShiftLabel: offer?.offeredShiftLabel,
        offeredShift: offer?.offeredShift,
        summary:
          'Shift Swap Acceptance (manager approval): ' +
          offerLabel +
          (swapAcceptNote.trim() ? '. Note: ' + swapAcceptNote.trim() : ''),
      });
      if (!res.ok) Alert.alert(t('common.error'), res.message);
      else {
        Alert.alert(t('common.sent'), t('actions.waitingApproval'));
        setSwapAcceptNote('');
        setSwapAcceptId(null);
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, swapAcceptId, swapAcceptNote, openSwapOffers, nameForRequests, roleCode, refetch]);

  const submitCallout = useCallback(async () => {
    if (!supabase) {
      Alert.alert(t('common.error'), t('errors.notConfigured'));
      return;
    }
    if (!calloutShift) {
      Alert.alert(t('actions.callouts'), t('actions.pickShift'));
      return;
    }
    if (!calloutReason.trim()) {
      Alert.alert(t('actions.callouts'), t('actions.addNotes'));
      return;
    }
    const optLabel = formatShiftRequestLabel(calloutShift);
    const summary = `Cannot work scheduled shift: ${optLabel}. ${calloutReason.trim()}`;
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'callout_request',
        employeeName: nameForRequests,
        role: roleCode,
        offeredShiftLabel: optLabel,
        offeredShift: {
          restaurantId: calloutShift.restaurantId,
          shiftId: calloutShift.id,
          day: calloutShift.day,
          timeLabel: compactShiftTimeLabel(calloutShift),
          iso: calloutShift.iso,
        },
        summary,
      });
      if (!res.ok) Alert.alert(t('common.error'), res.message);
      else {
        Alert.alert(t('common.sent'), t('actions.submittedManager'));
        setCalloutReason('');
        setCalloutShift(null);
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, calloutShift, calloutReason, nameForRequests, roleCode, refetch]);

  const requestTypeLabel = (type: string) => {
    if (type === 'availability') return t('employee.requestAvailability');
    if (type === 'timeoff') return t('employee.requestTimeOff');
    if (type === 'swap') return t('employee.requestSwap');
    if (type === 'callout_request' || type === 'callout') return t('employee.requestCallout');
    return type;
  };

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      nestedScrollEnabled
      showsVerticalScrollIndicator
    >
      {!myEmployee && displayName ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{t('employee.submittingAs', { name: displayName })}</Text>
        </View>
      ) : null}

      <View style={styles.chipRow}>
        {CHIPS.map((c) => (
          <Pressable
            key={c.key}
            onPress={() => setActiveForm(c.key)}
            style={[styles.chip, activeForm === c.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, activeForm === c.key && styles.chipTextActive]}>{t(c.labelKey)}</Text>
          </Pressable>
        ))}
      </View>

      {activeForm === 'timeoff' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>{t('actions.timeoffHint')}</Text>
          <Text style={styles.fieldLabel}>{t('actions.leaveType')}</Text>
          <View style={styles.chipRow}>
            {(
              [
                { value: 'vacation' as const, labelKey: 'actions.vacation' },
                { value: 'sick' as const, labelKey: 'actions.sick' },
              ] as const
            ).map((opt) => {
              const on = timeoffLeaveType === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  style={[styles.chip, on && styles.chipActive]}
                  onPress={() => setTimeoffLeaveType(opt.value)}
                >
                  <Text style={[styles.chipText, on && styles.chipTextActive]}>{t(opt.labelKey)}</Text>
                </Pressable>
              );
            })}
          </View>
          <DatePickerField label={t('actions.startDate')} value={timeoffStartDate} onChange={setTimeoffStartDate} />
          <DatePickerField
            label={t('actions.endDate')}
            value={timeoffEndDate}
            onChange={setTimeoffEndDate}
            minimumDate={timeoffStartDate ?? undefined}
          />
          <Text style={styles.fieldLabel}>{t('actions.notesOptional')}</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder={t('actions.notesPlaceholder')}
            value={timeoffNote}
            onChangeText={setTimeoffNote}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitTimeoff()}>
            <Text style={styles.btnPrimaryText}>
              {busy ? t('common.submitting') : t('actions.submitTimeOff')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {activeForm === 'swap' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>{t('actions.swapHint')}</Text>

          <Text style={styles.sectionTitle}>{t('actions.offerShift')}</Text>
          {!workerShifts.length ? (
            <Text style={styles.muted}>{t('actions.noShiftsWindow')}</Text>
          ) : (
            <>
              <ScheduleWeekPicker
                mode="chips"
                weekMeta={weekMeta}
                weekIndices={shiftPickWeekIndices}
                selectedWeekIndex={shiftPickWeekIndex}
                onSelectWeekIndex={setShiftPickWeekIndex}
                currentWeekIndex={scheduleCurrentWeekIndex}
              />
              {!shiftsInPickWeek.length ? (
                <Text style={styles.muted}>{t('employee.noShiftsThisWeek')}</Text>
              ) : (
                shiftsInPickWeek.map((row) => (
                  <CompactShiftRow
                    key={`swap-${shiftOptionKey(row)}`}
                    row={row}
                    selected={swapOfferShift ? shiftOptionKey(swapOfferShift) === shiftOptionKey(row) : false}
                    onPress={() => setSwapOfferShift(row)}
                  />
                ))
              )}
            </>
          )}
          <Text style={[styles.fieldLabel, styles.mtSm]}>{t('actions.swapWith')}</Text>
          <View style={styles.chipRow}>
            <Pressable
              style={[styles.chip, !swapTargetId && styles.chipActive]}
              onPress={() => setSwapTargetId('')}
            >
              <Text style={[styles.chipText, !swapTargetId && styles.chipTextActive]}>
                {t('actions.swapEveryone')}
              </Text>
            </Pressable>
            {swapCoworkers.map((c) => {
              const on = swapTargetId === c.id;
              return (
                <Pressable
                  key={c.id}
                  style={[styles.chip, on && styles.chipActive]}
                  onPress={() => setSwapTargetId(c.id)}
                >
                  <Text style={[styles.chipText, on && styles.chipTextActive]} numberOfLines={1}>
                    {c.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={[styles.fieldLabel, styles.mtSm]}>{t('actions.notesOptional')}</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder={t('actions.swapNotesPlaceholder')}
            value={swapNote}
            onChangeText={setSwapNote}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mtSm]} disabled={busy} onPress={() => void submitSwapOffer()}>
            <Text style={styles.btnPrimaryText}>{busy ? t('common.posting') : t('actions.postOffer')}</Text>
          </Pressable>

          <View style={styles.sectionDivider} />
          <Text style={styles.sectionTitle}>{t('actions.openOffers')}</Text>
          {!openSwapOffers.length ? (
            <Text style={styles.muted}>{t('actions.noOpenOffers')}</Text>
          ) : (
            openSwapOffers.map((o) => {
              const sel = swapAcceptId === o.id;
              return (
                <Pressable
                  key={o.id}
                  style={[styles.offerRow, sel && styles.offerRowOn]}
                  onPress={() => setSwapAcceptId(o.id)}
                >
                  <Text style={styles.offerText} numberOfLines={2}>
                    {o.offeredShiftLabel}
                  </Text>
                  <Text style={styles.offerSub}>{t('common.from')} {o.employeeName}</Text>
                </Pressable>
              );
            })
          )}
          <Text style={[styles.fieldLabel, styles.mtSm]}>{t('actions.messageOptional')}</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder={t('actions.managerNotePlaceholder')}
            value={swapAcceptNote}
            onChangeText={setSwapAcceptNote}
            multiline
          />
          <Pressable style={[styles.btnSecondary, styles.mtSm]} disabled={busy} onPress={() => void submitSwapAccept()}>
            <Text style={styles.btnSecondaryText}>
              {busy ? t('common.submitting') : t('actions.requestAccept')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {activeForm === 'callout' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>{t('actions.calloutHint')}</Text>
          <Text style={styles.sectionTitle}>{t('actions.yourShift')}</Text>
          {!workerShifts.length ? (
            <Text style={styles.muted}>{t('actions.noShiftsContact')}</Text>
          ) : (
            <>
              <ScheduleWeekPicker
                mode="chips"
                weekMeta={weekMeta}
                weekIndices={shiftPickWeekIndices}
                selectedWeekIndex={shiftPickWeekIndex}
                onSelectWeekIndex={setShiftPickWeekIndex}
                currentWeekIndex={scheduleCurrentWeekIndex}
              />
              {!shiftsInPickWeek.length ? (
                <Text style={styles.muted}>{t('employee.noShiftsThisWeek')}</Text>
              ) : (
                shiftsInPickWeek.map((row) => (
                  <CompactShiftRow
                    key={`co-${shiftOptionKey(row)}`}
                    row={row}
                    selected={calloutShift ? shiftOptionKey(calloutShift) === shiftOptionKey(row) : false}
                    onPress={() => setCalloutShift(row)}
                  />
                ))
              )}
            </>
          )}
          <Text style={[styles.fieldLabel, styles.mt]}>{t('actions.managerNotes')}</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder={t('actions.calloutNotesPlaceholder')}
            value={calloutReason}
            onChangeText={setCalloutReason}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitCallout()}>
            <Text style={styles.btnPrimaryText}>
              {busy ? t('common.submitting') : t('actions.submitCallout')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {myRequests.length ? (
        <View style={[styles.card, styles.requestsCard]}>
          <Text style={styles.requestsTitle}>{t('employee.recentRequests')}</Text>
          {myRequests.map((r) => (
            <View
              key={r.id}
              style={[
                styles.requestRow,
                focusRequestId && r.id === focusRequestId ? styles.requestRowFocused : null,
              ]}
            >
              <Text style={styles.requestMain}>
                {requestTypeLabel(r.type)} · {statusLabel(swapRequestDisplayStatus(r, staffRequests))}
              </Text>
                <Text style={styles.requestSub}>
                  {formatStaffRequestSubmittedDate(r.submittedAt)} — {r.summary}
                </Text>
              </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 48 },
  banner: {
    backgroundColor: '#fffbeb',
    borderWidth: 1,
    borderColor: '#fde68a',
    borderRadius: 8,
    padding: 12,
    marginBottom: 14,
  },
  bannerText: { fontSize: 13, color: '#92400e', lineHeight: 19 },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 14,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    backgroundColor: '#fff',
  },
  chipActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  chipText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  chipTextActive: { color: '#c41230' },
  weekChipRow: { flexDirection: 'row', gap: 6, paddingVertical: 4, alignItems: 'center' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  hint: { fontSize: 14, color: '#555', lineHeight: 21, marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6, textTransform: 'uppercase' },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    padding: 12,
    marginBottom: 10,
    backgroundColor: '#fff',
    fontSize: 16,
  },
  tall: { minHeight: 88, textAlignVertical: 'top' },
  mt: { marginTop: 12 },
  mtSm: { marginTop: 10 },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#0f172a', marginBottom: 4 },
  sectionDivider: { height: 1, backgroundColor: '#e8eaed', marginVertical: 14 },
  offerRow: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    backgroundColor: '#fafbfc',
  },
  offerRowOn: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  offerText: { fontSize: 14, fontWeight: '600', color: '#0f172a' },
  offerSub: { fontSize: 12, color: '#64748b', marginTop: 2 },
  btnPrimary: { backgroundColor: '#c41230', padding: 14, borderRadius: 8, alignItems: 'center' },
  btnPrimaryText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  btnSecondary: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  btnSecondaryText: { color: '#334155', fontWeight: '700', fontSize: 15 },
  muted: { fontSize: 14, color: '#888' },
  requestsCard: { marginTop: 16 },
  requestsTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 10 },
  requestRow: {
    borderTopWidth: 1,
    borderTopColor: '#e8eaed',
    paddingTop: 10,
    marginTop: 10,
  },
  requestRowFocused: {
    backgroundColor: '#fff7ed',
    marginHorizontal: -8,
    paddingHorizontal: 8,
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#c41230',
  },
  requestMain: { fontSize: 14, fontWeight: '700', color: '#334155' },
  requestSub: { fontSize: 13, color: '#64748b', marginTop: 4, lineHeight: 18 },
});
