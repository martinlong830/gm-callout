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
import { useAppData } from '../../contexts/AppDataContext';
import { useAuth } from '../../contexts/AuthContext';
import { employeeDisplayName, staffTypeLabel } from '../../lib/employees';
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
import { insertStaffRequest } from '../../lib/staffRequests';
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

function shiftRowLabel(row: WorkerShiftRow): string {
  return `${row.day} · ${row.timeLabel} · ${row.restaurantName}`;
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

  const [timeoffStart, setTimeoffStart] = useState('');
  const [timeoffEnd, setTimeoffEnd] = useState('');
  const [timeoffNote, setTimeoffNote] = useState('');

  const [swapOfferShift, setSwapOfferShift] = useState<WorkerShiftRow | null>(null);
  const [swapNote, setSwapNote] = useState('');
  const [swapAcceptId, setSwapAcceptId] = useState<string | null>(null);
  const [swapAcceptNote, setSwapAcceptNote] = useState('');

  const [calloutShift, setCalloutShift] = useState<WorkerShiftRow | null>(null);
  const [calloutReason, setCalloutReason] = useState('');

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
    if (!timeoffStart || !timeoffEnd) {
      Alert.alert('Time off', 'Enter start and end dates (YYYY-MM-DD).');
      return;
    }
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
        setTimeoffStart('');
        setTimeoffEnd('');
        setTimeoffNote('');
        void refetch();
      }
    } finally {
      setBusy(false);
    }
  }, [supabase, timeoffStart, timeoffEnd, timeoffNote, nameForRequests, roleCode, refetch]);

  const submitSwapOffer = useCallback(async () => {
    if (!supabase) {
      Alert.alert('Error', 'Not configured');
      return;
    }
    if (!swapOfferShift) {
      Alert.alert('Shift swap', 'Choose one of your upcoming shifts to offer.');
      return;
    }
    const shiftLabel = shiftRowLabel(swapOfferShift);
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
    const optLabel = shiftRowLabel(calloutShift);
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

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
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
          <Text style={styles.fieldLabel}>Start date</Text>
          <TextInput
            style={styles.input}
            placeholder="YYYY-MM-DD"
            value={timeoffStart}
            onChangeText={setTimeoffStart}
            autoCapitalize="none"
          />
          <Text style={styles.fieldLabel}>End date</Text>
          <TextInput
            style={styles.input}
            placeholder="YYYY-MM-DD"
            value={timeoffEnd}
            onChangeText={setTimeoffEnd}
            autoCapitalize="none"
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
          <Text style={styles.hint}>
            Post a shift you want to trade, or pick up someone else’s open offer. Your manager approves every swap.
          </Text>

          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <View style={styles.badge}>
                <Text style={styles.badgeInner}>1</Text>
              </View>
              <View style={styles.panelHeadText}>
                <Text style={styles.panelTitle}>Offer a shift</Text>
                <Text style={styles.panelDesc}>
                  Choose an upcoming shift from your schedule to make available for others.
                </Text>
              </View>
            </View>
            {!workerShifts.length ? (
              <Text style={styles.muted}>No upcoming shifts in the published schedule.</Text>
            ) : (
              workerShifts.map((row) => {
                const sel = swapOfferShift?.id === row.id && swapOfferShift?.restaurantId === row.restaurantId;
                return (
                  <Pressable
                    key={`${row.restaurantId}-${row.id}`}
                    style={[styles.optionRow, sel && styles.optionRowActive]}
                    onPress={() => setSwapOfferShift(row)}
                  >
                    <Text style={styles.optionText}>{shiftRowLabel(row)}</Text>
                  </Pressable>
                );
              })
            )}
            <Text style={[styles.fieldLabel, styles.mt]}>Notes (optional)</Text>
            <TextInput
              style={[styles.input, styles.tall]}
              placeholder="Preferences, timing, or who you’d like to swap with…"
              value={swapNote}
              onChangeText={setSwapNote}
              multiline
            />
            <Pressable style={[styles.btnPrimary, styles.mt]} disabled={busy} onPress={() => void submitSwapOffer()}>
              <Text style={styles.btnPrimaryText}>{busy ? 'Posting…' : 'Post offer'}</Text>
            </Pressable>
          </View>

          <View style={styles.divider} />

          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <View style={[styles.badge, styles.badgeMuted]}>
                <Text style={styles.badgeInner}>2</Text>
              </View>
              <View style={styles.panelHeadText}>
                <Text style={styles.panelTitle}>Available shifts</Text>
                <Text style={styles.panelDesc}>
                  Accept an open offer from a teammate. It’s sent to your manager for approval.
                </Text>
              </View>
            </View>
            {!openSwapOffers.length ? (
              <Text style={styles.muted}>No open shift swap offers.</Text>
            ) : (
              openSwapOffers.map((o) => {
                const sel = swapAcceptId === o.id;
                return (
                  <Pressable
                    key={o.id}
                    style={[styles.optionRow, sel && styles.optionRowActive]}
                    onPress={() => setSwapAcceptId(o.id)}
                  >
                    <Text style={styles.optionText}>
                      {o.offeredShiftLabel} · offered by {o.employeeName}
                    </Text>
                  </Pressable>
                );
              })
            )}
            <Text style={[styles.fieldLabel, styles.mt]}>Message (optional)</Text>
            <TextInput
              style={[styles.input, styles.tall]}
              placeholder="Anything your manager should know…"
              value={swapAcceptNote}
              onChangeText={setSwapAcceptNote}
              multiline
            />
            <Pressable
              style={[styles.btnSecondary, styles.mt]}
              disabled={busy}
              onPress={() => void submitSwapAccept()}
            >
              <Text style={styles.btnSecondaryText}>{busy ? 'Submitting…' : 'Request to accept'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      {activeForm === 'callout' ? (
        <View style={styles.card}>
          <Text style={styles.fieldLabel}>Shift you can’t cover</Text>
          {!workerShifts.length ? (
            <Text style={styles.muted}>No scheduled shifts in the window — contact your manager.</Text>
          ) : (
            workerShifts.map((row) => {
              const sel = calloutShift?.id === row.id && calloutShift?.restaurantId === row.restaurantId;
              return (
                <Pressable
                  key={`c-${row.restaurantId}-${row.id}`}
                  style={[styles.optionRow, sel && styles.optionRowActive]}
                  onPress={() => setCalloutShift(row)}
                >
                  <Text style={styles.optionText}>{shiftRowLabel(row)}</Text>
                </Pressable>
              );
            })
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
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f4f6f8' },
  content: { padding: 16, paddingBottom: 40 },
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
  panel: { marginTop: 4 },
  panelHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginBottom: 10 },
  badge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: '#c41230',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeInner: { color: '#fff', fontWeight: '800', fontSize: 14 },
  badgeMuted: { backgroundColor: '#94a3b8' },
  panelHeadText: { flex: 1 },
  panelTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  panelDesc: { fontSize: 13, color: '#64748b', marginTop: 4, lineHeight: 18 },
  optionRow: {
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
    backgroundColor: '#f8fafc',
  },
  optionRowActive: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  optionText: { fontSize: 14, color: '#0f172a' },
  muted: { fontSize: 14, color: '#888' },
  divider: { height: 1, backgroundColor: '#e8eaed', marginVertical: 18 },
});
