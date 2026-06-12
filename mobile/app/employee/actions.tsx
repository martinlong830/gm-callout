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
import { AvailabilityMatrixEditor, availabilityCheckAll } from '../../components/AvailabilityMatrixEditor';
import { CompactShiftRow } from '../../components/CompactShiftRow';
import { DatePickerField } from '../../components/DatePickerField';
import { ScheduleWeekPicker } from '../../components/ScheduleWeekPicker';
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { employeeDisplayName, staffTypeLabel } from '../../lib/employees';
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
  assignmentShell,
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getAvailabilityWeekOptions,
  getThisMondayDate,
  getWorkerScheduleBuckets,
  loadDraftFromTeamState,
  mergeRemoteAssignments,
  SCHEDULE_VIEW_WEEK_COUNT,
  type WorkerShiftRow,
} from '../../lib/schedule/engine';
import type { EmployeeLite, RoleKey } from '../../lib/schedule/types';
import { formatStaffRequestSubmittedDate, insertStaffRequest } from '../../lib/staffRequests';
import { normalizeWeeklyGrid, type WeeklyGridNormalized } from '../../lib/weeklyAvailabilityMatrix';
import { supabase } from '../../lib/supabase';

type FormKey = 'availability' | 'timeoff' | 'swap' | 'callout';

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

const CHIPS: { key: FormKey; label: string }[] = [
  { key: 'availability', label: 'Availability' },
  { key: 'timeoff', label: 'Time Off' },
  { key: 'swap', label: 'Shift Swap' },
  { key: 'callout', label: 'Callout' },
];

export default function EmployeeActions() {
  const { displayName } = useAuth();
  const { myEmployee, employees, staffRequests, teamState, refetch } = useAppData();
  const roleCode = myEmployee?.staffType ?? 'Kitchen';
  const nameForRequests = myEmployee ? employeeDisplayName(myEmployee) : displayName;
  const roleLine = staffTypeLabel(roleCode);

  const [activeForm, setActiveForm] = useState<FormKey>('availability');
  const [busy, setBusy] = useState(false);

  const restaurants = useMemo(() => defaultRestaurants(), []);
  const weekMeta = useMemo(
    () => buildWeeksFromMonday(SCHEDULE_VIEW_WEEK_COUNT, getThisMondayDate()),
    []
  );
  const allWeekDays = useMemo(() => buildAllWeekDayLabels(weekMeta), [weekMeta]);
  const draftRows = useMemo(() => loadDraftFromTeamState(teamState?.draft_schedule), [teamState]);
  const assignmentStore = useMemo(() => {
    const ids = restaurants.map((r) => r.id);
    return mergeRemoteAssignments(assignmentShell(restaurants), teamState?.schedule_assignments, ids);
  }, [teamState, restaurants]);
  const lites = useMemo(() => employees.map(toLite), [employees]);

  const workerShifts = useMemo(() => {
    if (!nameForRequests.trim()) return [] as WorkerShiftRow[];
    const { today, upcoming } = getWorkerScheduleBuckets({
      workerName: nameForRequests,
      weekMeta,
      allWeekDays,
      draftRows,
      employees: lites,
      restaurants,
      assignmentStore,
    });
    return [...today, ...upcoming];
  }, [nameForRequests, weekMeta, allWeekDays, draftRows, lites, restaurants, assignmentStore]);

  const availWeekOptions = useMemo(() => getAvailabilityWeekOptions(weekMeta), [weekMeta]);
  const [selectedAvailWeekIndex, setSelectedAvailWeekIndex] = useState(0);
  const [availNorm, setAvailNorm] = useState<WeeklyGridNormalized>(() =>
    normalizeWeeklyGrid({}, roleCode, draftRows)
  );

  useEffect(() => {
    if (activeForm !== 'availability') return;
    setAvailNorm(normalizeWeeklyGrid(myEmployee?.weeklyGrid ?? {}, roleCode, draftRows));
    setSelectedAvailWeekIndex(0);
  }, [activeForm, myEmployee?.weeklyGrid, roleCode, draftRows]);

  const [timeoffStartDate, setTimeoffStartDate] = useState<Date | null>(null);
  const [timeoffEndDate, setTimeoffEndDate] = useState<Date | null>(null);
  const [timeoffNote, setTimeoffNote] = useState('');

  const [swapOfferShift, setSwapOfferShift] = useState<WorkerShiftRow | null>(null);
  const [swapNote, setSwapNote] = useState('');
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
        String(r.employeeName || '')
          .trim()
          .toLowerCase() !== self &&
        r.offeredShiftLabel
    );
  }, [staffRequests, nameForRequests]);

  const submitAvailability = useCallback(async () => {
    if (!supabase) {
      Alert.alert('Error', 'Not configured');
      return;
    }
    const weekOpt = availWeekOptions[selectedAvailWeekIndex];
    if (!weekOpt) {
      Alert.alert('Availability', 'Choose which week this applies to.');
      return;
    }
    setBusy(true);
    try {
      const gridPayload = availNorm as unknown as Record<string, unknown>;
      const res = await insertStaffRequest(supabase, {
        type: 'availability',
        employeeName: nameForRequests,
        role: roleCode,
        summary: `Availability update for ${weekOpt.label} (${roleLine}).`,
        submittedWeekLabel: weekOpt.label,
        submittedWeekIndex: weekOpt.weekIndex,
        submittedGrid: gridPayload,
      });
      if (!res.ok) Alert.alert('Error', res.message);
      else {
        Alert.alert('Sent', 'Submitted. Your manager will see it under Actions.');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [
    supabase,
    availWeekOptions,
    selectedAvailWeekIndex,
    availNorm,
    nameForRequests,
    roleCode,
    roleLine,
    refetch,
  ]);

  const submitTimeoff = useCallback(async () => {
    if (!supabase) {
      Alert.alert('Error', 'Not configured');
      return;
    }
    if (!timeoffStartDate || !timeoffEndDate) {
      Alert.alert('Time off', 'Choose start and end dates.');
      return;
    }
    const timeoffStart = isoDate(timeoffStartDate);
    const timeoffEnd = isoDate(timeoffEndDate);
    if (timeoffEnd < timeoffStart) {
      Alert.alert('Time off', 'End date must be on or after start.');
      return;
    }
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'timeoff',
        employeeName: nameForRequests,
        role: roleCode,
        summary: `Time Off: ${timeoffStart} to ${timeoffEnd}${timeoffNote.trim() ? `. Notes: ${timeoffNote.trim()}` : ''}`,
      });
      if (!res.ok) Alert.alert('Error', res.message);
      else {
        Alert.alert('Sent', 'Submitted. Your manager will see it under Actions.');
        setTimeoffStartDate(null);
        setTimeoffEndDate(null);
        setTimeoffNote('');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, timeoffStartDate, timeoffEndDate, timeoffNote, nameForRequests, roleCode, refetch]);

  const submitSwapOffer = useCallback(async () => {
    if (!supabase) {
      Alert.alert('Error', 'Not configured');
      return;
    }
    if (!swapOfferShift) {
      Alert.alert('Shift swap', 'Choose one of your upcoming shifts to offer.');
      return;
    }
    const shiftLabel = formatShiftRequestLabel(swapOfferShift);
    setBusy(true);
    try {
      const res = await insertStaffRequest(supabase, {
        type: 'swap',
        employeeName: nameForRequests,
        role: roleCode,
        offeredShiftLabel: shiftLabel,
        summary:
          'Shift Swap Offer: ' +
          shiftLabel +
          (swapNote.trim() ? '. Notes: ' + swapNote.trim() : ''),
      });
      if (!res.ok) Alert.alert('Error', res.message);
      else {
        Alert.alert('Sent', 'Posted. Your manager approves every swap.');
        setSwapNote('');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, swapOfferShift, swapNote, nameForRequests, roleCode, refetch]);

  const submitSwapAccept = useCallback(async () => {
    if (!supabase) {
      Alert.alert('Error', 'Not configured');
      return;
    }
    if (!swapAcceptId) {
      Alert.alert('Shift swap', 'Choose an open offer to accept.');
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
        summary:
          'Shift Swap Acceptance (manager approval): ' +
          offerLabel +
          (swapAcceptNote.trim() ? '. Note: ' + swapAcceptNote.trim() : ''),
      });
      if (!res.ok) Alert.alert('Error', res.message);
      else {
        Alert.alert('Sent', 'Submitted. Waiting for manager approval.');
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
      Alert.alert('Error', 'Not configured');
      return;
    }
    if (!calloutShift) {
      Alert.alert('Callout', 'Pick a shift from the list.');
      return;
    }
    if (!calloutReason.trim()) {
      Alert.alert('Callout', 'Add notes for your manager.');
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
        summary,
      });
      if (!res.ok) Alert.alert('Error', res.message);
      else {
        Alert.alert('Sent', 'Submitted. Your manager will see it under Actions.');
        setCalloutReason('');
        setCalloutShift(null);
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, calloutShift, calloutReason, nameForRequests, roleCode, refetch]);

  const requestTypeLabel = (t: string) => {
    if (t === 'availability') return 'Availability';
    if (t === 'timeoff') return 'Time off';
    if (t === 'swap') return 'Shift swap';
    if (t === 'callout_request' || t === 'callout') return 'Callout';
    return t;
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
          <Text style={styles.bannerText}>
            Submitting as {displayName}. If requests fail to appear for your manager, ask them to link your login to
            your roster row in Team.
          </Text>
        </View>
      ) : null}

      <View style={styles.chipRow}>
        {CHIPS.map((c) => (
          <Pressable
            key={c.key}
            onPress={() => setActiveForm(c.key)}
            style={[styles.chip, activeForm === c.key && styles.chipActive]}
          >
            <Text style={[styles.chipText, activeForm === c.key && styles.chipTextActive]}>{c.label}</Text>
          </Pressable>
        ))}
      </View>

      {activeForm === 'availability' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>
            Set availability by role-based time slots and choose which week it applies to.
          </Text>
          <Text style={styles.fieldLabel}>Week</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.weekChipRow}>
            {availWeekOptions.map((w, idx) => (
              <Pressable
                key={w.label}
                onPress={() => setSelectedAvailWeekIndex(idx)}
                style={[styles.chip, idx === selectedAvailWeekIndex && styles.chipActive]}
              >
                <Text style={[styles.chipText, idx === selectedAvailWeekIndex && styles.chipTextActive]} numberOfLines={1}>
                  {w.label}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <AvailabilityMatrixEditor
            staffType={roleCode}
            draftRows={draftRows}
            normalized={availNorm}
            onChange={setAvailNorm}
            embedInParentScroll
          />
          <Pressable
            style={[styles.btnSecondary, styles.mt]}
            onPress={() => setAvailNorm((g) => availabilityCheckAll(roleCode, draftRows, g))}
          >
            <Text style={styles.btnSecondaryText}>Check all</Text>
          </Pressable>
          <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitAvailability()}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Submitting…' : 'Submit availability'}</Text>
          </Pressable>
        </View>
      ) : null}

      {activeForm === 'timeoff' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>Select the day range you need off. This submits as full-day time off.</Text>
          <DatePickerField label="Start date" value={timeoffStartDate} onChange={setTimeoffStartDate} />
          <DatePickerField
            label="End date"
            value={timeoffEndDate}
            onChange={setTimeoffEndDate}
            minimumDate={timeoffStartDate ?? undefined}
          />
          <Text style={styles.fieldLabel}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder="Reason, partial-day details, or context…"
            value={timeoffNote}
            onChangeText={setTimeoffNote}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitTimeoff()}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Submitting…' : 'Submit Time Off'}</Text>
          </Pressable>
        </View>
      ) : null}

      {activeForm === 'swap' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>Offer a shift or accept a teammate’s offer. Manager approval required.</Text>

          <Text style={styles.sectionTitle}>Offer a shift</Text>
          {!workerShifts.length ? (
            <Text style={styles.muted}>No shifts in the current schedule window.</Text>
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
                <Text style={styles.muted}>No shifts this week.</Text>
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
          <Text style={[styles.fieldLabel, styles.mtSm]}>Notes (optional)</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder="Preferences or who you’d like to swap with…"
            value={swapNote}
            onChangeText={setSwapNote}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mtSm]} disabled={busy} onPress={() => void submitSwapOffer()}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Posting…' : 'Post offer'}</Text>
          </Pressable>

          <View style={styles.sectionDivider} />
          <Text style={styles.sectionTitle}>Open offers</Text>
          {!openSwapOffers.length ? (
            <Text style={styles.muted}>No open swap offers.</Text>
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
                  <Text style={styles.offerSub}>from {o.employeeName}</Text>
                </Pressable>
              );
            })
          )}
          <Text style={[styles.fieldLabel, styles.mtSm]}>Message (optional)</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder="Note for your manager…"
            value={swapAcceptNote}
            onChangeText={setSwapAcceptNote}
            multiline
          />
          <Pressable style={[styles.btnSecondary, styles.mtSm]} disabled={busy} onPress={() => void submitSwapAccept()}>
            <Text style={styles.btnSecondaryText}>{busy ? 'Submitting…' : 'Request to accept'}</Text>
          </Pressable>
        </View>
      ) : null}

      {activeForm === 'callout' ? (
        <View style={styles.card}>
          <Text style={styles.hint}>Select the shift you cannot work. Your manager will review it.</Text>
          <Text style={styles.sectionTitle}>Your shift</Text>
          {!workerShifts.length ? (
            <Text style={styles.muted}>No scheduled shifts in the window — contact your manager.</Text>
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
                <Text style={styles.muted}>No shifts this week.</Text>
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
          <Text style={[styles.fieldLabel, styles.mt]}>Notes for your manager</Text>
          <TextInput
            style={[styles.input, styles.tall]}
            placeholder="Why you need coverage…"
            value={calloutReason}
            onChangeText={setCalloutReason}
            multiline
          />
          <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitCallout()}>
            <Text style={styles.btnPrimaryText}>{busy ? 'Submitting…' : 'Submit Callout'}</Text>
          </Pressable>
        </View>
      ) : null}

      {myRequests.length ? (
        <View style={[styles.card, styles.requestsCard]}>
          <Text style={styles.requestsTitle}>Your recent requests</Text>
          {myRequests.map((r) => {
            const status =
              r.status === 'approved' ? 'Approved' : r.status === 'declined' ? 'Declined' : 'Pending';
            return (
              <View key={r.id} style={styles.requestRow}>
                <Text style={styles.requestMain}>
                  {requestTypeLabel(r.type)} · {status}
                </Text>
                <Text style={styles.requestSub}>
                  {formatStaffRequestSubmittedDate(r.submittedAt)} — {r.summary}
                </Text>
              </View>
            );
          })}
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
  requestMain: { fontSize: 14, fontWeight: '700', color: '#334155' },
  requestSub: { fontSize: 13, color: '#64748b', marginTop: 4, lineHeight: 18 },
});
