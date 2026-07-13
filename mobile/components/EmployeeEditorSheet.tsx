import * as ImagePicker from 'expo-image-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { AvailabilityMatrixEditor } from './AvailabilityMatrixEditor';
import { EmployeePhoto } from './EmployeePhoto';
import {
  ensureEmployeeLeaveBalance,
  leaveSummaryLines,
  normalizeLeaveBalance,
} from '../lib/employeeLeave';
import {
  assignEmployeeClockPin,
  applyLeaveAllowancesToMeta,
  saveEmployeeRow,
  setEmployeeClockPin,
} from '../lib/employeeSave';
import {
  employeeDisplayName,
  isCloudEmployeeId,
  staffTypeLabel,
  type EmployeeRow,
} from '../lib/employees';
import { isPortalAuthConfigured, portalCreateEmployeeAccount, portalGetAccount } from '../lib/portalAuth';
import type { DraftGrid } from '../lib/schedule/types';
import { employeePhotoUploadHint, clearEmployeePhoto, uploadEmployeePhotoFromUri } from '../lib/uploadEmployeePhoto';
import { supabase } from '../lib/supabase';
import { normalizeWeeklyGrid, type WeeklyGridNormalized } from '../lib/weeklyAvailabilityMatrix';

const STAFF_TYPES = [
  { value: 'Bartender', label: 'Front of the House' },
  { value: 'Kitchen', label: 'Back of the House' },
  { value: 'Server', label: 'Delivery/Dishwasher' },
] as const;

const LOCATIONS = [
  { value: 'rp-9', label: 'Red Poke 598 9th Ave' },
  { value: 'rp-8', label: 'Red Poke 885 8th Ave' },
  { value: 'both', label: 'Both locations' },
] as const;

const BREAK_POLICIES = [
  { value: 'unpaid', label: 'Unpaid — break deducted' },
  { value: 'paid', label: 'Paid — break counts as work' },
] as const;

function SectionBlock({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionBody}>{children}</View>
    </View>
  );
}

function FieldLabel({ children }: { children: string }) {
  return <Text style={styles.label}>{children}</Text>;
}

function ChipRow({
  options,
  value,
  onChange,
}: {
  options: readonly { value: string; label: string }[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const on = value === opt.value;
        return (
          <Pressable
            key={opt.value}
            style={[styles.chip, on && styles.chipOn]}
            onPress={() => onChange(opt.value)}
          >
            <Text style={[styles.chipText, on && styles.chipTextOn]} numberOfLines={2}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

type Props = {
  employee: EmployeeRow | null;
  visible: boolean;
  isCreate?: boolean;
  draftRows: DraftGrid;
  onClose: () => void;
  onSaved: () => void;
};

export function EmployeeEditorSheet({ employee, visible, isCreate, draftRows, onClose, onSaved }: Props) {
  const { height: windowHeight } = useWindowDimensions();
  const sheetMaxHeight = Math.round(windowHeight * 0.9);

  const [profileEmployee, setProfileEmployee] = useState<EmployeeRow | null>(employee);
  const [photoVersion, setPhotoVersion] = useState(0);
  const [photoBusy, setPhotoBusy] = useState(false);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [staffType, setStaffType] = useState('Kitchen');
  const [phone, setPhone] = useState('');
  const [usualRestaurant, setUsualRestaurant] = useState('rp-9');
  const [hourlyRate, setHourlyRate] = useState('');
  const [tipPoint, setTipPoint] = useState('');
  const [breakPolicy, setBreakPolicy] = useState<'paid' | 'unpaid'>('unpaid');
  const [weeklyGrid, setWeeklyGrid] = useState<WeeklyGridNormalized>(() =>
    normalizeWeeklyGrid({}, 'Kitchen', { Kitchen: [], Bartender: [], Server: [] })
  );
  const [clockPin, setClockPin] = useState('');
  const [pinDraft, setPinDraft] = useState('');
  const [vacAllowanceDays, setVacAllowanceDays] = useState('0');
  const [sickAllowanceDays, setSickAllowanceDays] = useState('5');
  const [sickAllowanceHours, setSickAllowanceHours] = useState('');
  const [sickHoursRemaining, setSickHoursRemaining] = useState('');
  const [portalPassword, setPortalPassword] = useState('pass');
  const [portalRecoveryEmail, setPortalRecoveryEmail] = useState('');
  const [portalAccountType, setPortalAccountType] = useState<'employee' | 'manager'>('employee');
  const [canCreateManager, setCanCreateManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState('');

  const resetCreateForm = useCallback(() => {
    setProfileEmployee(null);
    setPhotoVersion((v) => v + 1);
    setFirstName('');
    setLastName('');
    setStaffType('Kitchen');
    setPhone('');
    setUsualRestaurant('rp-9');
    setHourlyRate('');
    setTipPoint('');
    setBreakPolicy('unpaid');
    setWeeklyGrid(normalizeWeeklyGrid({}, 'Kitchen', draftRows));
    setClockPin('');
    setPinDraft('');
    setVacAllowanceDays('0');
    setSickAllowanceDays('5');
    setSickAllowanceHours('');
    setSickHoursRemaining('');
    setPortalPassword('pass');
    setPortalRecoveryEmail('');
    setPortalAccountType('employee');
    setStatusMsg('');
  }, [draftRows]);

  useEffect(() => {
    if (!visible || !isCreate || !isPortalAuthConfigured()) {
      setCanCreateManager(false);
      return;
    }
    let cancelled = false;
    void portalGetAccount().then((acct) => {
      if (cancelled) return;
      setCanCreateManager(!!(acct.ok && acct.isCompanyCreator));
    });
    return () => {
      cancelled = true;
    };
  }, [visible, isCreate]);

  useEffect(() => {
    setProfileEmployee(employee);
    setPhotoVersion((v) => v + 1);
  }, [employee?.id, visible]);

  const resetFromEmployee = useCallback(
    (emp: EmployeeRow) => {
      ensureEmployeeLeaveBalance(emp);
      const bal = normalizeLeaveBalance(emp.meta?.leaveBalance);
      setFirstName(emp.firstName || '');
      setLastName(emp.lastName || '');
      setStaffType(emp.staffType || 'Kitchen');
      setPhone(emp.phone || '');
      setUsualRestaurant(
        emp.usualRestaurant === 'both' || emp.usualRestaurant === 'rp-8'
          ? emp.usualRestaurant
          : 'rp-9'
      );
      setHourlyRate(emp.hourlyRate != null ? String(emp.hourlyRate) : '');
      setTipPoint(emp.tipPoint != null ? String(emp.tipPoint) : '');
      setBreakPolicy(emp.meta?.breakPolicy === 'paid' ? 'paid' : 'unpaid');
      setWeeklyGrid(normalizeWeeklyGrid(emp.weeklyGrid ?? {}, emp.staffType, draftRows));
      setClockPin(emp.clockPin || '');
      setPinDraft(emp.clockPin || '');
      setVacAllowanceDays(String(bal.vacation.allowanceDays ?? 0));
      setSickAllowanceDays(String(bal.sick.allowanceDays ?? 5));
      setSickAllowanceHours(
        bal.sick.allowanceHours != null ? String(bal.sick.allowanceHours) : ''
      );
      setSickHoursRemaining(
        bal.sick.hoursRemaining != null ? String(bal.sick.hoursRemaining) : ''
      );
      setStatusMsg('');
    },
    [draftRows]
  );

  useEffect(() => {
    if (!visible) return;
    if (isCreate) {
      resetCreateForm();
      return;
    }
    if (employee) resetFromEmployee(employee);
  }, [employee?.id, visible, isCreate, resetFromEmployee, employee, resetCreateForm]);

  const normalizedGrid = useMemo(
    () => normalizeWeeklyGrid(weeklyGrid, staffType, draftRows),
    [weeklyGrid, staffType, draftRows]
  );

  const leaveLines = useMemo(() => {
    if (!employee) return [];
    const preview: EmployeeRow = {
      ...employee,
      firstName,
      lastName,
      meta: { ...(employee.meta ?? {}) },
    };
    applyLeaveAllowancesToMeta(preview.meta!, {
      vacAllowanceDays,
      sickAllowanceDays,
      sickAllowanceHours,
      sickHoursRemaining,
    });
    return leaveSummaryLines(preview);
  }, [
    employee,
    firstName,
    lastName,
    vacAllowanceDays,
    sickAllowanceDays,
    sickAllowanceHours,
    sickHoursRemaining,
  ]);

  function onStaffTypeChange(next: string) {
    setStaffType(next);
    setWeeklyGrid((g) => normalizeWeeklyGrid(g, next, draftRows));
  }

  async function handleAssignRandomPin() {
    if (!employee || !supabase) return;
    setBusy(true);
    const res = await assignEmployeeClockPin(supabase, employee.id);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('PIN', res.message);
      return;
    }
    setClockPin(res.pin);
    setPinDraft(res.pin);
    setStatusMsg('Random PIN assigned.');
  }

  async function handleSavePinOnly() {
    if (!employee || !supabase) return;
    setBusy(true);
    const res = await setEmployeeClockPin(supabase, employee.id, pinDraft);
    setBusy(false);
    if (!res.ok) {
      Alert.alert('PIN', res.message);
      return;
    }
    setClockPin(res.pin);
    setPinDraft(res.pin);
    setStatusMsg('Time clock PIN saved.');
  }

  async function handleSaveEmployee() {
    if (!supabase) {
      Alert.alert('Save', 'Supabase is not configured.');
      return;
    }
    const first = firstName.trim();
    const last = lastName.trim();
    if (!first || !last) {
      Alert.alert('Profile', 'First and last name are required.');
      return;
    }
    const phoneTrim = phone.trim();
    if (isCreate && !phoneTrim) {
      Alert.alert('Profile', 'Phone number is required for new employees.');
      return;
    }
    const hrRaw = hourlyRate.trim();
    const hrNum = hrRaw === '' ? undefined : parseFloat(hrRaw);
    if (hrNum != null && (Number.isNaN(hrNum) || hrNum < 0)) {
      Alert.alert('Profile', 'Enter a valid hourly rate.');
      return;
    }
    const tpRaw = tipPoint.trim();
    const tpNum = tpRaw === '' ? undefined : parseFloat(tpRaw);
    if (tpNum != null && (Number.isNaN(tpNum) || tpNum < 0)) {
      Alert.alert('Profile', 'Enter a valid tip point.');
      return;
    }

    let authUserId = employee?.authUserId;
    let portalCreateWarning: string | null = null;
    if (isCreate) {
      const pw = portalPassword.trim() || 'pass';
      if (pw.length < 4) {
        Alert.alert('App login', 'Password must be at least 4 characters.');
        return;
      }
      if (isPortalAuthConfigured()) {
        const displayNameNew = `${first} ${last}`.trim();
        const portalPayload: Parameters<typeof portalCreateEmployeeAccount>[0] = {
          loginName: displayNameNew,
          password: pw,
          displayName: displayNameNew,
          phone: phoneTrim,
          staffType,
          role: canCreateManager ? portalAccountType : 'employee',
        };
        const recovery = portalRecoveryEmail.trim();
        if (recovery) portalPayload.recoveryEmail = recovery;
        setBusy(true);
        const portalRes = await portalCreateEmployeeAccount(portalPayload);
        if (!portalRes.ok) {
          portalCreateWarning = portalRes.message;
        } else if (portalRes.userId) {
          authUserId = portalRes.userId;
        }
      }
    } else if (!employee) {
      return;
    }

    const meta = { ...(employee?.meta ?? {}) } as Record<string, unknown>;
    meta.breakPolicy = breakPolicy;
    applyLeaveAllowancesToMeta(meta, {
      vacAllowanceDays,
      sickAllowanceDays,
      sickAllowanceHours,
      sickHoursRemaining,
    });

    const updated: EmployeeRow = {
      ...(employee ?? {
        id:
          typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID
            ? globalThis.crypto.randomUUID()
            : `emp-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      }),
      firstName: first,
      lastName: last,
      displayName: `${first} ${last}`.trim(),
      staffType,
      phone: phoneTrim,
      usualRestaurant,
      hourlyRate: hrNum != null ? Math.round(hrNum * 100) / 100 : undefined,
      tipPoint: tpNum != null ? tpNum : undefined,
      weeklyGrid: normalizeWeeklyGrid(weeklyGrid, staffType, draftRows) as unknown as Record<
        string,
        unknown
      >,
      clockPin: clockPin || undefined,
      authUserId,
      meta,
    };

    setBusy(true);
    const saved = await saveEmployeeRow(supabase, updated);
    setBusy(false);
    if (!saved.ok) {
      Alert.alert('Save', saved.message);
      return;
    }
    if (isCloudEmployeeId(updated.id) && pinDraft && pinDraft !== clockPin) {
      const pinRes = await setEmployeeClockPin(supabase, updated.id, pinDraft);
      if (pinRes.ok) {
        updated.clockPin = pinRes.pin;
      }
    } else if (isCloudEmployeeId(updated.id) && !clockPin && !pinDraft) {
      void assignEmployeeClockPin(supabase, updated.id);
    }
    if (portalCreateWarning) {
      Alert.alert(
        isCreate ? 'Employee added' : 'Employee saved',
        `Saved to the roster, but app login was not created: ${portalCreateWarning}`
      );
    }
    setStatusMsg(isCreate ? 'Employee added.' : 'Employee saved.');
    onSaved();
    onClose();
  }

  async function pickPhoto() {
    const emp = profileEmployee ?? employee;
    if (!emp || !supabase) return;
    if (!isCloudEmployeeId(emp.id)) {
      Alert.alert('Photo', employeePhotoUploadHint(emp));
      return;
    }
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert('Photos', 'Allow photo library access to upload a profile picture.');
      return;
    }
    const picked = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.85,
    });
    if (picked.canceled || !picked.assets[0]) return;
    const asset = picked.assets[0];
    setPhotoBusy(true);
    const res = await uploadEmployeePhotoFromUri(
      supabase,
      emp,
      asset.uri,
      asset.mimeType ?? null,
      asset.fileSize ?? null
    );
    setPhotoBusy(false);
    if (!res.ok) {
      Alert.alert('Photo', res.message);
      return;
    }
    setProfileEmployee(res.employee);
    setPhotoVersion((v) => v + 1);
    onSaved();
  }

  async function removePhoto() {
    const emp = profileEmployee ?? employee;
    if (!emp || !supabase) return;
    Alert.alert('Remove photo', 'Hide the profile photo and show initials instead?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            if (!supabase) return;
            setPhotoBusy(true);
            const res = await clearEmployeePhoto(supabase, emp);
            setPhotoBusy(false);
            if (!res.ok) {
              Alert.alert('Photo', res.message);
              return;
            }
            setProfileEmployee(res.employee);
            setPhotoVersion((v) => v + 1);
            onSaved();
          })();
        },
      },
    ]);
  }

  if (!visible) return null;
  if (!isCreate && !employee) return null;

  const photoEmp = profileEmployee ?? employee;
  const hasCustomPhoto = !!(photoEmp?.meta?.photoUseCustom && photoEmp?.meta?.photoUrl);
  const sheetTitle = isCreate ? 'Add employee' : employeeDisplayName(employee!);

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.keyboardRoot}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.backdrop}>
          <Pressable style={styles.backdropTap} onPress={onClose} accessibilityLabel="Close" />
          <View style={[styles.sheet, { height: sheetMaxHeight }]}>
            <View style={styles.sheetHandle} />
            <View style={styles.sheetHeader}>
              {photoEmp ? (
                <EmployeePhoto employee={photoEmp} size={72} version={photoVersion} />
              ) : (
                <View style={styles.photoPlaceholder} />
              )}
              <View style={styles.sheetHeaderText}>
                <Text style={styles.sheetTitle}>{sheetTitle}</Text>
                <Text style={styles.sheetSubtitle}>{staffTypeLabel(staffType)}</Text>
                {!isCreate && photoEmp ? (
                  <View style={styles.photoActions}>
                    <Pressable
                      style={[styles.photoBtn, photoBusy && styles.photoBtnDisabled]}
                      onPress={() => void pickPhoto()}
                      disabled={photoBusy}
                    >
                      {photoBusy ? (
                        <ActivityIndicator size="small" color="#c41230" />
                      ) : (
                        <Text style={styles.photoBtnText}>Upload photo</Text>
                      )}
                    </Pressable>
                    {hasCustomPhoto ? (
                      <Pressable
                        style={styles.photoBtnSecondary}
                        onPress={() => void removePhoto()}
                        disabled={photoBusy}
                      >
                        <Text style={styles.photoBtnSecondaryText}>Remove</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : isCreate ? (
                  <Text style={styles.photoHint}>Save the employee, then upload a photo.</Text>
                ) : null}
                {photoEmp ? (
                  <Text style={styles.photoHint}>{employeePhotoUploadHint(photoEmp)}</Text>
                ) : null}
              </View>
            </View>

            <ScrollView
              style={styles.scroll}
              contentContainerStyle={styles.scrollContent}
              bounces
              keyboardShouldPersistTaps="handled"
              nestedScrollEnabled
              showsVerticalScrollIndicator
            >
              <SectionBlock title="Profile">
                <View style={styles.row2}>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>First name</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={firstName}
                      onChangeText={setFirstName}
                      autoCapitalize="words"
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Last name</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={lastName}
                      onChangeText={setLastName}
                      autoCapitalize="words"
                    />
                  </View>
                </View>
                <FieldLabel>Staff type</FieldLabel>
                <ChipRow options={STAFF_TYPES} value={staffType} onChange={onStaffTypeChange} />
                <FieldLabel>Phone</FieldLabel>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  placeholder="e.g. 609-250-8527"
                />
                <FieldLabel>Location</FieldLabel>
                <ChipRow
                  options={LOCATIONS}
                  value={usualRestaurant}
                  onChange={setUsualRestaurant}
                />
                <View style={styles.row2}>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Hourly rate ($)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={hourlyRate}
                      onChangeText={setHourlyRate}
                      keyboardType="decimal-pad"
                      placeholder="18.00"
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Tip point</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={tipPoint}
                      onChangeText={setTipPoint}
                      keyboardType="decimal-pad"
                      placeholder="3"
                    />
                  </View>
                </View>
                {isCreate ? (
                  <>
                    {canCreateManager ? (
                      <>
                        <FieldLabel>Account type</FieldLabel>
                        <ChipRow
                          options={[
                            { value: 'employee', label: 'Employee' },
                            { value: 'manager', label: 'Manager' },
                          ]}
                          value={portalAccountType}
                          onChange={(v) =>
                            setPortalAccountType(v === 'manager' ? 'manager' : 'employee')
                          }
                        />
                      </>
                    ) : null}
                    <FieldLabel>App login password</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={portalPassword}
                      onChangeText={setPortalPassword}
                      secureTextEntry
                      placeholder="Default: pass"
                    />
                    <FieldLabel>Recovery email (optional)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={portalRecoveryEmail}
                      onChangeText={setPortalRecoveryEmail}
                      keyboardType="email-address"
                      autoCapitalize="none"
                      placeholder="forgot-password link"
                    />
                    {!isPortalAuthConfigured() ? (
                      <Text style={styles.readOnlyNote}>
                        Set EXPO_PUBLIC_GM_WEB_URL to create portal login from mobile.
                      </Text>
                    ) : null}
                  </>
                ) : employee?.authUserId ? (
                  <Text style={styles.readOnlyNote}>App login: linked to portal account</Text>
                ) : (
                  <Text style={styles.readOnlyNote}>App login: not linked</Text>
                )}
              </SectionBlock>

              <SectionBlock title="Schedule">
                <Text style={styles.sectionHint}>Weekly availability (tap cells to toggle).</Text>
                <AvailabilityMatrixEditor
                  staffType={staffType}
                  draftRows={draftRows}
                  normalized={normalizedGrid}
                  onChange={setWeeklyGrid}
                  embedInParentScroll
                />
              </SectionBlock>

              <SectionBlock title="Time clock">
                <FieldLabel>Default break policy</FieldLabel>
                <ChipRow
                  options={BREAK_POLICIES}
                  value={breakPolicy}
                  onChange={(v) => setBreakPolicy(v === 'paid' ? 'paid' : 'unpaid')}
                />
                <Text style={styles.sectionHint}>
                  Applies when a shift or punch does not specify otherwise.
                </Text>
                {isCreate ? (
                  <Text style={styles.readOnlyNote}>
                    A random PIN is assigned automatically when the employee is saved.
                  </Text>
                ) : employee && isCloudEmployeeId(employee.id) ? (
                  <>
                    <FieldLabel>Time clock PIN</FieldLabel>
                    <Text style={styles.pinDisplay}>{clockPin || 'Not assigned'}</Text>
                    <FieldLabel>Custom 4-digit PIN</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={pinDraft}
                      onChangeText={(t) => setPinDraft(t.replace(/\D/g, '').slice(0, 4))}
                      keyboardType="number-pad"
                      maxLength={4}
                      placeholder="0000"
                    />
                    <View style={styles.pinBtnRow}>
                      <Pressable
                        style={styles.secondaryBtn}
                        onPress={() => void handleAssignRandomPin()}
                        disabled={busy}
                      >
                        <Text style={styles.secondaryBtnText}>Random PIN</Text>
                      </Pressable>
                      <Pressable
                        style={styles.secondaryBtn}
                        onPress={() => void handleSavePinOnly()}
                        disabled={busy}
                      >
                        <Text style={styles.secondaryBtnText}>Save PIN only</Text>
                      </Pressable>
                    </View>
                  </>
                ) : (
                  <Text style={styles.readOnlyNote}>
                    Save this employee to the cloud roster before assigning a PIN.
                  </Text>
                )}
              </SectionBlock>

              <SectionBlock title="Vacation & sick leave">
                <Text style={styles.sectionHint}>
                  Allowances save with the employee. Used-day entries match web (read-only here).
                </Text>
                <View style={styles.row2}>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Vacation allowance (days)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={vacAllowanceDays}
                      onChangeText={setVacAllowanceDays}
                      keyboardType="number-pad"
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Sick allowance (days)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={sickAllowanceDays}
                      onChangeText={setSickAllowanceDays}
                      keyboardType="number-pad"
                    />
                  </View>
                </View>
                <View style={styles.row2}>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Sick bank (hours, optional)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={sickAllowanceHours}
                      onChangeText={setSickAllowanceHours}
                      keyboardType="decimal-pad"
                      placeholder="—"
                    />
                  </View>
                  <View style={styles.fieldHalf}>
                    <FieldLabel>Sick remaining (hrs, optional)</FieldLabel>
                    <TextInput
                      style={styles.input}
                      value={sickHoursRemaining}
                      onChangeText={setSickHoursRemaining}
                      keyboardType="decimal-pad"
                      placeholder="—"
                    />
                  </View>
                </View>
                {leaveLines.map((line) => (
                  <Text key={line} style={styles.leaveLine}>
                    {line}
                  </Text>
                ))}
              </SectionBlock>

              <View style={styles.scrollSpacer} />
            </ScrollView>

            <View style={styles.footer}>
              {statusMsg ? <Text style={styles.statusMsg}>{statusMsg}</Text> : null}
              <Pressable
                style={[styles.primaryBtn, busy && styles.btnDisabled]}
                onPress={() => void handleSaveEmployee()}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.primaryBtnText}>{busy ? 'Saving…' : isCreate ? 'Add employee' : 'Save employee'}</Text>
                )}
              </Pressable>
              <Pressable style={styles.ghostBtn} onPress={onClose} disabled={busy}>
                <Text style={styles.ghostBtnText}>Close without saving</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  keyboardRoot: { flex: 1 },
  backdrop: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(15,23,42,0.45)',
  },
  backdropTap: {
    ...StyleSheet.absoluteFillObject,
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    width: '100%',
    overflow: 'hidden',
    flexDirection: 'column',
  },
  sheetHandle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#cbd5e1',
    marginTop: 10,
    marginBottom: 4,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e8eaed',
  },
  photoPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: '#e8ecf1',
  },
  sheetHeaderText: { flex: 1, minWidth: 0 },
  sheetTitle: { fontSize: 20, fontWeight: '800', color: '#0f172a' },
  sheetSubtitle: { fontSize: 15, color: '#64748b', marginTop: 4 },
  photoActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  photoBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    backgroundColor: '#fff1f2',
    borderWidth: 1,
    borderColor: '#fecdd3',
  },
  photoBtnDisabled: { opacity: 0.6 },
  photoBtnText: { color: '#c41230', fontWeight: '600', fontSize: 14 },
  photoBtnSecondary: { paddingHorizontal: 12, paddingVertical: 8 },
  photoBtnSecondaryText: { color: '#64748b', fontWeight: '600', fontSize: 14 },
  photoHint: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  scroll: { flex: 1 },
  scrollContent: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 16 },
  scrollSpacer: { height: 8 },
  section: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: '#e8eaed',
    borderRadius: 10,
    backgroundColor: '#fafbfc',
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#334155',
    paddingHorizontal: 14,
    paddingVertical: 10,
    backgroundColor: '#f1f5f9',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  sectionBody: { padding: 14, gap: 10 },
  sectionHint: { fontSize: 13, color: '#64748b', lineHeight: 18, marginBottom: 4 },
  label: {
    fontSize: 12,
    fontWeight: '600',
    color: '#64748b',
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.3,
  },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    color: '#0f172a',
    backgroundColor: '#fff',
  },
  row2: { flexDirection: 'row', gap: 10 },
  fieldHalf: { flex: 1, minWidth: 0 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
    maxWidth: '100%',
  },
  chipOn: { borderColor: '#c41230', backgroundColor: '#fef2f2' },
  chipText: { fontSize: 13, color: '#475569' },
  chipTextOn: { color: '#c41230', fontWeight: '600' },
  readOnlyNote: { fontSize: 13, color: '#64748b', marginTop: 4 },
  pinDisplay: {
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 4,
    color: '#0f172a',
    marginBottom: 8,
  },
  pinBtnRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  secondaryBtn: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    alignItems: 'center',
    backgroundColor: '#fff',
  },
  secondaryBtnText: { fontSize: 14, fontWeight: '600', color: '#334155' },
  leaveLine: { fontSize: 13, color: '#334155', lineHeight: 20 },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 16,
    borderTopWidth: 1,
    borderTopColor: '#e8eaed',
    backgroundColor: '#fff',
    gap: 10,
  },
  statusMsg: { fontSize: 13, color: '#047857', textAlign: 'center' },
  primaryBtn: {
    backgroundColor: '#c41230',
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
  },
  primaryBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ghostBtn: { paddingVertical: 10, alignItems: 'center' },
  ghostBtnText: { fontSize: 15, color: '#64748b', fontWeight: '600' },
  btnDisabled: { opacity: 0.6 },
});
