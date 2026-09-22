import { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { DatePickerField } from './DatePickerField';
import { CompactShiftRow } from './CompactShiftRow';
import { useI18n } from '../contexts/LocaleContext';
import {
  employeeDisplayName,
  employeeIsDeactivated,
  employeeVisibleInManagerStoreScope,
  managerManagedRestaurantId,
  type EmployeeRow,
} from '../lib/employees';
import { insertStaffRequest, type StaffRequestUi } from '../lib/staffRequests';
import { coworkerSwapTargets } from '../lib/shiftSwap';
import { supabase } from '../lib/supabase';
import {
  compactShiftTimeLabel,
  formatCalendarDateLabel,
  shiftOptionKey,
} from '../lib/schedule/employeeShiftDisplay';
import {
  buildAllWeekDayLabels,
  buildWeeksFromMonday,
  defaultRestaurants,
  getScheduleAnchorMondayDate,
  getWorkerScheduleBuckets,
  hydrateScheduleAssignmentsFromTeamState,
  SCHEDULE_VIEW_WEEK_COUNT,
  DEFAULT_DRAFT_SCHEDULE_ROWS,
  type WorkerShiftRow,
} from '../lib/schedule/engine';
import type { AssignmentStore, EmployeeLite, RoleKey } from '../lib/schedule/types';

type FormKey = 'timeoff' | 'swap' | 'callout';

function toLite(e: EmployeeRow): EmployeeLite {
  return {
    firstName: e.firstName,
    lastName: e.lastName,
    displayName: e.displayName,
    staffType: (e.staffType || 'Kitchen') as RoleKey,
    usualRestaurant: e.usualRestaurant || 'both',
  };
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatShiftRequestLabel(row: WorkerShiftRow): string {
  return `${formatCalendarDateLabel(row)} · ${compactShiftTimeLabel(row)} · ${row.restaurantName}`;
}

async function loadApproveStaffRequest() {
  const m = await import('../lib/approveStaffRequest');
  return m.approveStaffRequest;
}

type Props = {
  employees: EmployeeRow[];
  myEmployee: EmployeeRow | null;
  role: string | null | undefined;
  teamState: {
    schedule_assignments?: unknown;
    draft_schedule?: unknown;
    schedule_published?: unknown;
  } | null;
  onApplied?: (opts: { store?: AssignmentStore; draftSchedule?: unknown }) => void;
};

export function ManagerFileStaffRequest({
  employees,
  myEmployee,
  role,
  teamState,
  onApplied,
}: Props) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [empId, setEmpId] = useState('');
  const [form, setForm] = useState<FormKey>('timeoff');
  const [busy, setBusy] = useState(false);

  const [timeoffStartDate, setTimeoffStartDate] = useState<Date | null>(null);
  const [timeoffEndDate, setTimeoffEndDate] = useState<Date | null>(null);
  const [timeoffLeaveType, setTimeoffLeaveType] = useState<'vacation' | 'sick'>('vacation');
  const [timeoffNote, setTimeoffNote] = useState('');

  const [swapShift, setSwapShift] = useState<WorkerShiftRow | null>(null);
  const [swapTargetId, setSwapTargetId] = useState('');
  const [swapNote, setSwapNote] = useState('');

  const [calloutShift, setCalloutShift] = useState<WorkerShiftRow | null>(null);
  const [calloutNote, setCalloutNote] = useState('');

  const storeScope = useMemo(
    () => managerManagedRestaurantId(myEmployee, role),
    [myEmployee, role]
  );

  const roster = useMemo(
    () =>
      employees
        .filter((e) => {
          if (employeeIsDeactivated(e)) return false;
          if (storeScope && !employeeVisibleInManagerStoreScope(e, storeScope)) return false;
          return !!employeeDisplayName(e).trim();
        })
        .slice()
        .sort((a, b) => employeeDisplayName(a).localeCompare(employeeDisplayName(b))),
    [employees, storeScope]
  );

  const selected = useMemo(
    () => roster.find((e) => e.id === empId) || null,
    [roster, empId]
  );
  const workerName = selected ? employeeDisplayName(selected) : '';
  const roleCode = (selected?.staffType || 'Kitchen') as string;

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
  const lites = useMemo(() => employees.map(toLite), [employees]);

  const workerShifts = useMemo(() => {
    if (!workerName.trim()) return [] as WorkerShiftRow[];
    const { today, upcoming } = getWorkerScheduleBuckets({
      workerName,
      weekMeta,
      allWeekDays,
      draftScheduleRaw: hydrated.draftSchedule ?? teamState?.draft_schedule,
      employees: lites,
      restaurants,
      assignmentStore: hydrated.store,
      schedulePublishedRaw: teamState?.schedule_published,
      requirePublished: false,
      respectUsualRestaurant: false,
    });
    return [...today, ...upcoming];
  }, [
    workerName,
    weekMeta,
    allWeekDays,
    hydrated.draftSchedule,
    hydrated.store,
    teamState?.draft_schedule,
    teamState?.schedule_published,
    lites,
    restaurants,
  ]);

  const swapCoworkers = useMemo(
    () => coworkerSwapTargets(employees, workerName, selected?.id),
    [employees, workerName, selected?.id]
  );

  const assignmentStore = hydrated.store;

  const submitAndMaybeApprove = useCallback(
    async (payload: Parameters<typeof insertStaffRequest>[1], autoApprove: boolean) => {
      if (!selected) {
        Alert.alert(t('requests.fileForEmployee'), t('requests.chooseEmployeeFirst'));
        return false;
      }
      if (!supabase) {
        Alert.alert(t('common.error'), t('errors.notConfigured'));
        return false;
      }
      setBusy(true);
      try {
        const ins = await insertStaffRequest(supabase, payload);
        if (!ins.ok) {
          Alert.alert(t('common.error'), ins.message);
          return false;
        }
        if (!autoApprove) {
          Alert.alert(t('common.sent'), t('requests.swapPosted'));
          onApplied?.({});
          return true;
        }
        const approveStaffRequest = await loadApproveStaffRequest();
        const req: StaffRequestUi = {
          id: ins.id,
          type: payload.type,
          employeeName: payload.employeeName,
          role: payload.role,
          summary: payload.summary,
          submittedAt: payload.submittedAt || new Date().toISOString().slice(0, 10),
          status: 'pending',
          offeredShiftLabel: payload.offeredShiftLabel,
          offeredShift: payload.offeredShift,
          leaveType: payload.leaveType,
          timeoffStart: payload.timeoffStart,
          timeoffEnd: payload.timeoffEnd,
        };
        const res = await approveStaffRequest(
          supabase,
          req,
          employees,
          DEFAULT_DRAFT_SCHEDULE_ROWS,
          {
            assignmentStore,
            draftScheduleRaw: teamState?.draft_schedule,
          }
        );
        if (!res.ok) {
          Alert.alert(t('requests.updateFailed'), res.message);
          return false;
        }
        Alert.alert(t('common.sent'), t('requests.autoApproved'));
        onApplied?.({ store: res.store, draftSchedule: res.draftSchedule });
        return true;
      } finally {
        setBusy(false);
      }
    },
    [selected, employees, assignmentStore, teamState?.draft_schedule, onApplied, t]
  );

  const onSubmitTimeoff = useCallback(async () => {
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
    const ok = await submitAndMaybeApprove(
      {
        type: 'timeoff',
        employeeName: workerName,
        role: roleCode,
        leaveType: timeoffLeaveType,
        timeoffStart,
        timeoffEnd,
        summary: `${typeLabel}: ${timeoffStart} to ${timeoffEnd}${timeoffNote.trim() ? `. Notes: ${timeoffNote.trim()}` : ''} (filed by manager)`,
      },
      true
    );
    if (ok) {
      setTimeoffStartDate(null);
      setTimeoffEndDate(null);
      setTimeoffNote('');
    }
  }, [
    timeoffStartDate,
    timeoffEndDate,
    timeoffLeaveType,
    timeoffNote,
    workerName,
    roleCode,
    submitAndMaybeApprove,
    t,
  ]);

  const onSubmitSwap = useCallback(async () => {
    if (!swapShift) {
      Alert.alert(t('actions.shiftSwaps'), t('actions.chooseShiftOffer'));
      return;
    }
    const shiftLabel = formatShiftRequestLabel(swapShift);
    const target = swapTargetId
      ? swapCoworkers.find((c) => c.id === swapTargetId) || null
      : null;
    const ok = await submitAndMaybeApprove(
      {
        type: 'swap',
        employeeName: workerName,
        role: roleCode,
        offeredShiftLabel: shiftLabel,
        offeredShift: {
          restaurantId: swapShift.restaurantId,
          shiftId: swapShift.id,
          day: swapShift.day,
          timeLabel: compactShiftTimeLabel(swapShift),
          iso: swapShift.iso,
        },
        swapTargetEmployeeId: target ? target.id : null,
        swapTargetEmployeeName: target ? target.name : null,
        summary:
          'Shift Swap Offer: ' +
          shiftLabel +
          (target ? `. Requested cover: ${target.name}` : '. Send to everyone') +
          (swapNote.trim() ? `. Notes: ${swapNote.trim()}` : '') +
          ' (filed by manager)',
      },
      false
    );
    if (ok) {
      setSwapNote('');
      setSwapTargetId('');
    }
  }, [
    swapShift,
    swapTargetId,
    swapCoworkers,
    swapNote,
    workerName,
    roleCode,
    submitAndMaybeApprove,
    t,
  ]);

  const onSubmitCallout = useCallback(async () => {
    if (!calloutShift) {
      Alert.alert(t('actions.callouts'), t('actions.pickShift'));
      return;
    }
    if (!calloutNote.trim()) {
      Alert.alert(t('actions.callouts'), t('actions.addNotes'));
      return;
    }
    const shiftLabel = formatShiftRequestLabel(calloutShift);
    const ok = await submitAndMaybeApprove(
      {
        type: 'callout_request',
        employeeName: workerName,
        role: roleCode,
        offeredShiftLabel: shiftLabel,
        offeredShift: {
          restaurantId: calloutShift.restaurantId,
          shiftId: calloutShift.id,
          day: calloutShift.day,
          timeLabel: compactShiftTimeLabel(calloutShift),
          iso: calloutShift.iso,
        },
        summary: `Callout: ${shiftLabel}. ${calloutNote.trim()} (filed by manager)`,
      },
      true
    );
    if (ok) setCalloutNote('');
  }, [calloutShift, calloutNote, workerName, roleCode, submitAndMaybeApprove, t]);

  return (
    <View style={styles.wrap}>
      <Pressable style={styles.toggle} onPress={() => setOpen((v) => !v)}>
        <Text style={styles.toggleText}>{t('requests.fileForEmployee')}</Text>
        <Text style={styles.toggleChevron}>{open ? '▾' : '▸'}</Text>
      </Pressable>
      {open ? (
        <View style={styles.body}>
          <Text style={styles.hint}>{t('requests.fileForEmployeeHint')}</Text>
          <Text style={styles.fieldLabel}>{t('requests.employee')}</Text>
          <View style={styles.empList}>
            {roster.map((e) => {
              const on = e.id === empId;
              return (
                <Pressable
                  key={e.id}
                  style={[styles.empChip, on && styles.empChipOn]}
                  onPress={() => {
                    setEmpId(e.id);
                    setSwapShift(null);
                    setCalloutShift(null);
                  }}
                >
                  <Text style={[styles.empChipText, on && styles.empChipTextOn]}>
                    {employeeDisplayName(e)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <View style={styles.chipRow}>
            {(
              [
                { key: 'timeoff' as const, labelKey: 'actions.timeOff' },
                { key: 'swap' as const, labelKey: 'actions.shiftSwaps' },
                { key: 'callout' as const, labelKey: 'actions.callouts' },
              ] as const
            ).map((c) => (
              <Pressable
                key={c.key}
                style={[styles.chip, form === c.key && styles.chipOn]}
                onPress={() => setForm(c.key)}
              >
                <Text style={[styles.chipText, form === c.key && styles.chipTextOn]}>{t(c.labelKey)}</Text>
              </Pressable>
            ))}
          </View>

          {form === 'timeoff' ? (
            <>
              <Text style={styles.hint}>{t('requests.timeoffAutoHint')}</Text>
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
                      style={[styles.chip, on && styles.chipOn]}
                      onPress={() => setTimeoffLeaveType(opt.value)}
                    >
                      <Text style={[styles.chipText, on && styles.chipTextOn]}>{t(opt.labelKey)}</Text>
                    </Pressable>
                  );
                })}
              </View>
              <DatePickerField
                label={t('actions.startDate')}
                value={timeoffStartDate}
                onChange={setTimeoffStartDate}
              />
              <DatePickerField
                label={t('actions.endDate')}
                value={timeoffEndDate}
                onChange={setTimeoffEndDate}
                minimumDate={timeoffStartDate ?? undefined}
              />
              <Text style={styles.fieldLabel}>{t('actions.notesOptional')}</Text>
              <TextInput
                style={[styles.input, styles.tall]}
                value={timeoffNote}
                onChangeText={setTimeoffNote}
                multiline
              />
              <Pressable
                style={[styles.btn, busy && styles.btnDisabled]}
                disabled={busy}
                onPress={() => void onSubmitTimeoff()}
              >
                <Text style={styles.btnText}>
                  {busy ? t('common.submitting') : t('requests.approveTimeOff')}
                </Text>
              </Pressable>
            </>
          ) : null}

          {form === 'swap' ? (
            <>
              <Text style={styles.hint}>{t('requests.swapOfferHint')}</Text>
              {!workerShifts.length ? (
                <Text style={styles.muted}>{t('actions.noShiftsWindow')}</Text>
              ) : (
                workerShifts.map((row) => (
                  <CompactShiftRow
                    key={`mgr-swap-${shiftOptionKey(row)}`}
                    row={row}
                    selected={swapShift ? shiftOptionKey(swapShift) === shiftOptionKey(row) : false}
                    onPress={() => setSwapShift(row)}
                  />
                ))
              )}
              <Text style={styles.fieldLabel}>{t('actions.swapWith')}</Text>
              <Pressable
                style={[styles.empChip, !swapTargetId && styles.empChipOn]}
                onPress={() => setSwapTargetId('')}
              >
                <Text style={[styles.empChipText, !swapTargetId && styles.empChipTextOn]}>
                  {t('actions.swapEveryone')}
                </Text>
              </Pressable>
              {swapCoworkers.map((c) => {
                const on = swapTargetId === c.id;
                return (
                  <Pressable
                    key={c.id}
                    style={[styles.empChip, on && styles.empChipOn]}
                    onPress={() => setSwapTargetId(c.id)}
                  >
                    <Text style={[styles.empChipText, on && styles.empChipTextOn]}>{c.name}</Text>
                  </Pressable>
                );
              })}
              <Text style={styles.fieldLabel}>{t('actions.notesOptional')}</Text>
              <TextInput
                style={[styles.input, styles.tall]}
                value={swapNote}
                onChangeText={setSwapNote}
                multiline
              />
              <Pressable
                style={[styles.btn, busy && styles.btnDisabled]}
                disabled={busy}
                onPress={() => void onSubmitSwap()}
              >
                <Text style={styles.btnText}>
                  {busy ? t('common.submitting') : t('actions.postOffer')}
                </Text>
              </Pressable>
            </>
          ) : null}

          {form === 'callout' ? (
            <>
              <Text style={styles.hint}>{t('requests.calloutAutoHint')}</Text>
              {!workerShifts.length ? (
                <Text style={styles.muted}>{t('actions.noShiftsWindow')}</Text>
              ) : (
                workerShifts.map((row) => (
                  <CompactShiftRow
                    key={`mgr-co-${shiftOptionKey(row)}`}
                    row={row}
                    selected={
                      calloutShift ? shiftOptionKey(calloutShift) === shiftOptionKey(row) : false
                    }
                    onPress={() => setCalloutShift(row)}
                  />
                ))
              )}
              <Text style={styles.fieldLabel}>{t('actions.notesOptional')}</Text>
              <TextInput
                style={[styles.input, styles.tall]}
                value={calloutNote}
                onChangeText={setCalloutNote}
                multiline
              />
              <Pressable
                style={[styles.btn, busy && styles.btnDisabled]}
                disabled={busy}
                onPress={() => void onSubmitCallout()}
              >
                <Text style={styles.btnText}>
                  {busy ? t('common.submitting') : t('requests.approveCallout')}
                </Text>
              </Pressable>
            </>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaed',
  },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  toggleText: { fontSize: 15, fontWeight: '700', color: '#1e293b' },
  toggleChevron: { fontSize: 16, color: '#64748b' },
  body: { paddingHorizontal: 16, paddingBottom: 16, gap: 8 },
  hint: { fontSize: 13, color: '#64748b', lineHeight: 18, marginBottom: 4 },
  fieldLabel: { fontSize: 13, fontWeight: '600', color: '#334155', marginTop: 6 },
  empList: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  empChip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    backgroundColor: '#fff',
    marginBottom: 4,
  },
  empChipOn: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  empChipText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  empChipTextOn: { color: '#c41230' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginVertical: 4 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    backgroundColor: '#fff',
  },
  chipOn: { borderColor: '#c41230', backgroundColor: '#fff1f2' },
  chipText: { fontSize: 13, color: '#475569', fontWeight: '600' },
  chipTextOn: { color: '#c41230' },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontSize: 15,
    backgroundColor: '#fff',
  },
  tall: { minHeight: 64, textAlignVertical: 'top' },
  muted: { fontSize: 13, color: '#94a3b8' },
  btn: {
    marginTop: 8,
    backgroundColor: '#c41230',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
});
