import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { EmployeeRow } from '../lib/employees';
import {
  calculateMasterHoursAfterBreak,
  calculateMasterShiftHours,
  formatMasterTemplateChoice,
  masterTemplateRowsForRole,
  normalizeMasterTemplateRow,
  normalizeScheduleTemplates,
  templateSectionForRole,
  type MasterTemplate,
  type MasterTemplateRow,
  type NormalTemplate,
  type ScheduleTemplate,
} from '../lib/schedule/templates';
import type { ScheduleRow } from '../lib/schedule/types';

type CopyRow = {
  role: ScheduleRow['role'];
  trIdx: number;
  employee: string;
  days: Record<string, ScheduleRow | undefined>;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  schedule: ScheduleRow[];
  visibleDays: string[];
  employees: EmployeeRow[];
  templates: unknown[];
  canEdit: boolean;
  onSaveTemplates: (templates: ScheduleTemplate[]) => Promise<boolean>;
  onDeleteTemplate: (id: string) => Promise<boolean>;
  onApplyTemplate: (template: NormalTemplate) => void;
  t: (key: string) => string;
};

const ROLE_INDEX: Record<string, number> = { Kitchen: 0, Bartender: 1, Server: 2 };

function scheduleCopyRows(schedule: ScheduleRow[], visibleDays: string[]): CopyRow[] {
  const byKey = new Map<string, CopyRow>();
  for (const row of schedule) {
    if (!visibleDays.includes(row.day)) continue;
    const key = `${row.role}:${row.trIdx}`;
    let copy = byKey.get(key);
    if (!copy) {
      copy = {
        role: row.role,
        trIdx: row.trIdx,
        employee: row.workers?.find((name) => name && name !== 'Unassigned') || 'Unassigned',
        days: {},
      };
      byKey.set(key, copy);
    }
    copy.days[row.day] = { ...row };
  }
  return Array.from(byKey.values());
}

function masterTemplateForId(templates: ScheduleTemplate[], id: string): MasterTemplate | null {
  const found = templates.find((template) => template.kind === 'master' && template.id === id);
  return found?.kind === 'master' ? found : null;
}

export function ScheduleTemplatesSheet({
  visible,
  onClose,
  schedule,
  visibleDays,
  employees,
  templates: templatesRaw,
  canEdit,
  onSaveTemplates,
  onDeleteTemplate,
  onApplyTemplate,
  t,
}: Props) {
  const tx = (key: string, fallback: string) => {
    const value = t(key);
    return value && value !== key ? value : fallback;
  };
  const templates = useMemo(() => normalizeScheduleTemplates(templatesRaw), [templatesRaw]);
  const normalTemplates = useMemo(
    () => templates.filter((template): template is NormalTemplate => template.kind !== 'master'),
    [templates]
  );
  const masterTemplates = useMemo(
    () => templates.filter((template): template is MasterTemplate => template.kind === 'master'),
    [templates]
  );
  const [mode, setMode] = useState<'normal' | 'master'>('normal');
  const [normalName, setNormalName] = useState('');
  const [selectedNormalId, setSelectedNormalId] = useState('');
  const [selectedMasterId, setSelectedMasterId] = useState('');
  const [copyRows, setCopyRows] = useState<CopyRow[]>([]);
  const [choiceByCell, setChoiceByCell] = useState<Record<string, string>>({});
  const [masterDraft, setMasterDraft] = useState<MasterTemplate | null>(null);
  const [employeePicker, setEmployeePicker] = useState<CopyRow | null>(null);
  const [choicePicker, setChoicePicker] = useState<{ key: string; choices: MasterTemplateRow[] } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible) return;
    setMode('normal');
    setNormalName('');
    setSelectedNormalId('');
    setSelectedMasterId('');
    setCopyRows(scheduleCopyRows(schedule, visibleDays));
    setChoiceByCell({});
    setMasterDraft(null);
  }, [visible, schedule, visibleDays]);

  const selectedMaster = masterTemplateForId(templates, selectedMasterId);

  const setCopyEmployee = (rowKey: string, employee: string) => {
    setCopyRows((rows) =>
      rows.map((row) =>
        `${row.role}:${row.trIdx}` === rowKey ? { ...row, employee } : row
      )
    );
  };

  const setCopyTime = (
    rowKey: string,
    day: string,
    field: 'start' | 'end',
    value: string
  ) => {
    setCopyRows((rows) =>
      rows.map((row) => {
        if (`${row.role}:${row.trIdx}` !== rowKey) return row;
        const shift = row.days[day];
        if (!shift) return row;
        return { ...row, days: { ...row.days, [day]: { ...shift, [field]: value } } };
      })
    );
  };

  const loadNormalTemplate = (template: NormalTemplate) => {
    const nextRows = scheduleCopyRows(schedule, visibleDays);
    const pattern =
      template.weekPattern && typeof template.weekPattern === 'object'
        ? (template.weekPattern as Record<string, unknown>)
        : {};
    for (const key of Object.keys(pattern)) {
      const parts = key.split('-');
      if (parts.length !== 3) continue;
      const roleIndex = Number(parts[1]);
      const role = Object.keys(ROLE_INDEX).find((candidate) => ROLE_INDEX[candidate] === roleIndex);
      const trIdx = Number(parts[2]);
      const entry = pattern[key];
      const workers =
        entry && typeof entry === 'object' && Array.isArray((entry as { workers?: unknown[] }).workers)
          ? (entry as { workers: unknown[] }).workers
          : Array.isArray(entry)
            ? entry
            : [];
      const employee = workers.find((name) => name && name !== 'Unassigned');
      const row = nextRows.find((candidate) => candidate.role === role && candidate.trIdx === trIdx);
      if (row && employee) row.employee = String(employee);
    }
    if (template.draftSchedule && typeof template.draftSchedule === 'object') {
      const draft = template.draftSchedule as Record<string, unknown>;
      for (const row of nextRows) {
        const roleRows = draft[row.role];
        const draftRow =
          Array.isArray(roleRows) && Array.isArray(roleRows[row.trIdx])
            ? (roleRows[row.trIdx] as unknown[])
            : null;
        if (!draftRow) continue;
        visibleDays.forEach((day, dayIndex) => {
          const cell = draftRow[dayIndex];
          if (!Array.isArray(cell) || !cell[0] || !cell[1] || !row.days[day]) return;
          row.days[day] = {
            ...row.days[day],
            start: String(cell[0]),
            end: String(cell[1]),
            timeLabel: `${String(cell[0])}–${String(cell[1])}`,
          };
        });
      }
    }
    setCopyRows(nextRows);
    setSelectedNormalId(template.id);
    setNormalName(template.name);
    setSelectedMasterId(String(template.masterTemplateId || ''));
    setChoiceByCell(
      template.masterShiftChoices && typeof template.masterShiftChoices === 'object'
        ? (template.masterShiftChoices as Record<string, string>)
        : {}
    );
  };

  const saveNormalTemplate = async () => {
    const name = normalName.trim();
    if (!name) {
      Alert.alert(tx('schedule.templateNameRequired', 'Template name required'), 'Enter a name for this normal template.');
      return;
    }
    const weekPattern: Record<string, unknown> = {};
    const draftSchedule: Record<string, unknown> = {};
    for (const row of copyRows) {
      const roleIndex = ROLE_INDEX[row.role];
      if (roleIndex == null || row.employee === 'Unassigned') continue;
      const draftRows = (draftSchedule[row.role] ??= []) as unknown[];
      const draftRow = (draftRows[row.trIdx] ??= Array(visibleDays.length).fill(null)) as unknown[];
      visibleDays.forEach((day, dayIndex) => {
        const shift = row.days[day];
        const choice = masterTemplateRowsForRole(selectedMaster, row.role).find(
          (candidate) => candidate.id === choiceByCell[`${row.role}:${row.trIdx}:${day}`]
        );
        if (shift || choice) {
          weekPattern[`${dayIndex}-${roleIndex}-${row.trIdx}`] = {
            workers: [row.employee],
          };
          draftRow[dayIndex] = choice
            ? [choice.clockIn, choice.clockOut]
            : [shift?.start || null, shift?.end || null];
        }
      });
    }
    const nextNormal: NormalTemplate = {
      id: selectedNormalId || `tpl-${Date.now().toString(36)}`,
      kind: 'normal',
      name,
      createdAt: new Date().toISOString(),
      weekPattern,
      draftSchedule,
      masterTemplateId: selectedMasterId || undefined,
      masterShiftChoices: choiceByCell,
    };
    const next = templates
      .filter((template) => template.id !== nextNormal.id && template.name !== name)
      .concat(nextNormal);
    setSaving(true);
    const ok = await onSaveTemplates(next);
    setSaving(false);
    if (ok) {
      setSelectedNormalId(nextNormal.id);
      Alert.alert(tx('schedule.templateSaved', 'Template saved'), `"${name}" is ready to apply.`);
    }
  };

  const saveMasterTemplate = async () => {
    if (!masterDraft || !masterDraft.name.trim()) {
      Alert.alert(tx('schedule.masterTemplateNameRequired', 'Master Template name required'), 'Enter a name before saving.');
      return;
    }
    const next = templates
      .filter((template) => template.id !== masterDraft.id)
      .concat(masterDraft);
    setSaving(true);
    const ok = await onSaveTemplates(next);
    setSaving(false);
    if (ok) {
      setSelectedMasterId(masterDraft.id);
      Alert.alert(tx('schedule.masterTemplateSaved', 'Master Template saved'), `"${masterDraft.name}" is shared with managers.`);
    }
  };

  const deleteTemplate = async (template: ScheduleTemplate) => {
    Alert.alert('Delete template?', `"${template.name}" will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            const ok = await onDeleteTemplate(template.id);
            if (ok) {
              if (template.kind === 'master') setMasterDraft(null);
              setSelectedNormalId('');
              setSelectedMasterId('');
            }
          })();
        },
      },
    ]);
  };

  const updateMasterRow = (
    section: keyof MasterTemplate['sections'],
    index: number,
    patch: Partial<MasterTemplateRow>
  ) => {
    setMasterDraft((current) => {
      if (!current) return current;
      const rows = current.sections[section].slice();
      const next = normalizeMasterTemplateRow({ ...rows[index], ...patch }, index);
      rows[index] = next;
      return { ...current, sections: { ...current.sections, [section]: rows } };
    });
  };

  const normalContent = (
    <>
      <Text style={styles.help}>
        This is an editable copy of the schedule currently on screen. Employee choices stay on
        their schedule row; a Master Template restricts each section’s shift choices.
      </Text>
      <Text style={styles.label}>Saved normal template</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        {normalTemplates.map((template) => (
          <Pressable key={template.id} style={styles.chip} onPress={() => loadNormalTemplate(template)}>
            <Text style={styles.chipText}>{template.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <Text style={styles.label}>Master Template starting point</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
        <Pressable style={[styles.chip, !selectedMasterId && styles.chipActive]} onPress={() => setSelectedMasterId('')}>
          <Text style={styles.chipText}>None</Text>
        </Pressable>
        {masterTemplates.map((template) => (
          <Pressable
            key={template.id}
            style={[styles.chip, selectedMasterId === template.id && styles.chipActive]}
            onPress={() => {
              setSelectedMasterId(template.id);
              setChoiceByCell({});
            }}
          >
            <Text style={styles.chipText}>{template.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tableContent}>
        <View>
          <View style={styles.tableRow}>
            <Text style={[styles.headerCell, styles.employeeCell]}>Employee / section</Text>
            {visibleDays.map((day) => <Text key={day} style={styles.headerCell}>{day}</Text>)}
          </View>
          {copyRows.map((row) => (
            <View key={`${row.role}:${row.trIdx}`} style={styles.tableRow}>
              <Pressable
                style={[styles.cell, styles.employeeCell]}
                onPress={() => setEmployeePicker(row)}
              >
                <Text style={styles.cellText}>{row.employee}</Text>
                <Text style={styles.muted}>{templateSectionForRole(row.role)}</Text>
              </Pressable>
              {visibleDays.map((day, dayIndex) => {
                const shift = row.days[day];
                const cellKey = `${row.role}:${row.trIdx}:${day}`;
                const choices = masterTemplateRowsForRole(selectedMaster, row.role);
                const selectedChoice = choices.find((choice) => choice.id === choiceByCell[cellKey]);
                return (
                  <View key={day} style={styles.cell}>
                    <Text style={styles.cellText}>
                      {selectedChoice
                        ? formatMasterTemplateChoice(selectedChoice)
                        : shift
                          ? `${shift.start}–${shift.end}`
                          : 'Day off'}
                    </Text>
                    {selectedMaster ? (
                      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                        <Pressable
                          style={styles.choiceButton}
                          onPress={() => setChoicePicker({ key: cellKey, choices })}
                        >
                          <Text style={styles.choiceText}>
                            {selectedChoice
                              ? tx('schedule.chooseShiftOption', 'Change shift option')
                              : choices.length
                                ? tx('schedule.chooseShiftOption', 'Choose shift option')
                                : tx('schedule.noMasterOptions', 'No options in section')}
                          </Text>
                        </Pressable>
                      </ScrollView>
                    ) : null}
                    {shift ? (
                      <View style={styles.timeEditor}>
                        <TextInput
                          style={styles.timeInput}
                          value={selectedChoice?.clockIn || shift.start}
                          editable={!selectedMaster}
                          onChangeText={(value) => setCopyTime(`${row.role}:${row.trIdx}`, day, 'start', value)}
                          placeholder="HH:MM"
                          placeholderTextColor="#94a3b8"
                          keyboardType="numbers-and-punctuation"
                        />
                        <Text style={styles.timeSeparator}>–</Text>
                        <TextInput
                          style={styles.timeInput}
                          value={selectedChoice?.clockOut || shift.end}
                          editable={!selectedMaster}
                          onChangeText={(value) => setCopyTime(`${row.role}:${row.trIdx}`, day, 'end', value)}
                          placeholder="HH:MM"
                          placeholderTextColor="#94a3b8"
                          keyboardType="numbers-and-punctuation"
                        />
                      </View>
                    ) : null}
                    <Text style={styles.muted}>{dayIndex + 1}/7</Text>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
      <TextInput
        style={styles.input}
        value={normalName}
        onChangeText={setNormalName}
        placeholder="Normal template name"
        placeholderTextColor="#94a3b8"
      />
      <Pressable style={styles.primaryButton} onPress={() => void saveNormalTemplate()} disabled={saving}>
        <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save normal template'}</Text>
      </Pressable>
      {selectedNormalId ? (
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            const found = normalTemplates.find((template) => template.id === selectedNormalId);
            if (found) {
              onApplyTemplate(found);
              onClose();
            }
          }}
        >
          <Text style={styles.secondaryText}>Apply selected normal template</Text>
        </Pressable>
      ) : null}
      {selectedNormalId ? (
        <Pressable
          style={styles.secondaryButton}
          onPress={() => {
            const found = normalTemplates.find((template) => template.id === selectedNormalId);
            if (found) void deleteTemplate(found);
          }}
        >
          <Text style={styles.secondaryText}>Delete selected normal template</Text>
        </Pressable>
      ) : null}
    </>
  );

  const masterContent = masterDraft ? (
    <>
      <TextInput
        style={styles.input}
        value={masterDraft.name}
        onChangeText={(name) => setMasterDraft((current) => current && { ...current, name })}
        placeholder="Master Template name"
        placeholderTextColor="#94a3b8"
      />
      {(Object.keys(masterDraft.sections) as Array<keyof MasterTemplate['sections']>).map((section) => (
        <View key={section} style={styles.masterSection}>
          <Text style={styles.sectionTitle}>{section}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={styles.tableContent}>
            <View>
              <View style={styles.tableRow}>
                {['Role', 'Shift', 'Clock in', 'Clock out', 'Total hours', 'Break', 'Hours after break', 'Days/wk', ''].map((label) => (
                  <Text key={label} style={styles.masterHeaderCell}>{label}</Text>
                ))}
              </View>
              {masterDraft.sections[section].map((row, index) => (
                <View key={row.id} style={styles.tableRow}>
                  {([
                    ['role', row.role, 'Role'],
                    ['shift', row.shift, 'Shift'],
                    ['clockIn', row.clockIn, 'HH:MM'],
                    ['clockOut', row.clockOut, 'HH:MM'],
                  ] as const).map(([field, value, placeholder]) => (
                    <TextInput
                      key={field}
                      style={styles.masterInput}
                      value={value}
                      onChangeText={(text) => updateMasterRow(section, index, { [field]: text })}
                      placeholder={placeholder}
                      placeholderTextColor="#94a3b8"
                    />
                  ))}
                  <Text style={styles.masterValue}>{row.totalHours || calculateMasterShiftHours(row.clockIn, row.clockOut)}</Text>
                  <Pressable
                    style={styles.breakButton}
                    onPress={() => updateMasterRow(section, index, { break: row.break === '30' ? 'none' : '30' })}
                  >
                    <Text style={styles.cellText}>{row.break === '30' ? '30 minutes' : 'No break'}</Text>
                  </Pressable>
                  <Text style={styles.masterValue}>
                    {row.hoursAfterBreak || calculateMasterHoursAfterBreak(row.clockIn, row.clockOut, row.break)}
                  </Text>
                  <TextInput
                    style={styles.masterInput}
                    value={row.daysPerWeek}
                    onChangeText={(text) => updateMasterRow(section, index, { daysPerWeek: text })}
                    placeholder="Days/wk"
                    placeholderTextColor="#94a3b8"
                  />
                  <Pressable
                    style={styles.removeRowButton}
                    onPress={() =>
                      setMasterDraft((current) =>
                        current
                          ? {
                              ...current,
                              sections: {
                                ...current.sections,
                                [section]: current.sections[section].filter((_, rowIndex) => rowIndex !== index),
                              },
                            }
                          : current
                      )
                    }
                  >
                    <Text style={styles.secondaryText}>Remove</Text>
                  </Pressable>
                </View>
              ))}
            </View>
          </ScrollView>
          <Pressable
            style={styles.secondaryButton}
            onPress={() =>
              setMasterDraft((current) =>
                current
                  ? {
                      ...current,
                      sections: {
                        ...current.sections,
                        [section]: current.sections[section].concat(normalizeMasterTemplateRow({}, current.sections[section].length)),
                      },
                    }
                  : current
              )
            }
          >
            <Text style={styles.secondaryText}>Add {section} row</Text>
          </Pressable>
        </View>
      ))}
      <Pressable style={styles.primaryButton} onPress={() => void saveMasterTemplate()} disabled={saving}>
        <Text style={styles.primaryText}>{saving ? 'Saving…' : 'Save Master Template'}</Text>
      </Pressable>
      {masterDraft.id && masterTemplates.some((template) => template.id === masterDraft.id) ? (
        <Pressable style={styles.secondaryButton} onPress={() => void deleteTemplate(masterDraft)}>
          <Text style={styles.secondaryText}>Delete Master Template</Text>
        </Pressable>
      ) : null}
    </>
  ) : (
    <>
      <Text style={styles.help}>Create a shared guideline table for each staffing section.</Text>
      <Pressable
        style={styles.primaryButton}
        onPress={() =>
          setMasterDraft({
            id: `master-${Date.now().toString(36)}`,
            kind: 'master',
            name: '',
            createdAt: new Date().toISOString(),
            sections: { FOH: [], BOH: [], 'Delivery/Dishwasher': [] },
          })
        }
      >
        <Text style={styles.primaryText}>{t('schedule.masterTemplate')} +</Text>
      </Pressable>
      {masterTemplates.map((template) => (
        <Pressable key={template.id} style={styles.secondaryButton} onPress={() => setMasterDraft(template)}>
          <Text style={styles.secondaryText}>Edit {template.name}</Text>
        </Pressable>
      ))}
    </>
  );

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.screen}>
        <View style={styles.topBar}>
          <Text style={styles.title}>{t('schedule.templates')}</Text>
          <Pressable onPress={onClose}><Text style={styles.close}>{t('common.close')}</Text></Pressable>
        </View>
        <View style={styles.tabs}>
          <Pressable style={[styles.tab, mode === 'normal' && styles.tabActive]} onPress={() => setMode('normal')}>
            <Text style={styles.tabText}>{t('schedule.normalTemplate')}</Text>
          </Pressable>
          {canEdit ? (
            <Pressable style={[styles.tab, mode === 'master' && styles.tabActive]} onPress={() => setMode('master')}>
              <Text style={styles.tabText}>{t('schedule.masterTemplate')}</Text>
            </Pressable>
          ) : null}
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {mode === 'normal' ? normalContent : masterContent}
        </ScrollView>
        <Modal visible={!!employeePicker} transparent animationType="fade" onRequestClose={() => setEmployeePicker(null)}>
          <View style={styles.pickerBackdrop}>
            <View style={styles.picker}>
              <Text style={styles.sectionTitle}>Choose employee</Text>
              {employees
                .filter((employee) => employee.staffType === employeePicker?.role)
                .map((employee) => {
                  const name = employee.displayName || `${employee.firstName} ${employee.lastName}`.trim();
                  return (
                    <Pressable
                      key={employee.id}
                      style={styles.pickerOption}
                      onPress={() => {
                        if (employeePicker) setCopyEmployee(`${employeePicker.role}:${employeePicker.trIdx}`, name);
                        setEmployeePicker(null);
                      }}
                    >
                      <Text style={styles.cellText}>{name}</Text>
                    </Pressable>
                  );
                })}
              <Pressable
                style={styles.pickerOption}
                onPress={() => {
                  if (employeePicker) setCopyEmployee(`${employeePicker.role}:${employeePicker.trIdx}`, 'Unassigned');
                  setEmployeePicker(null);
                }}
              >
                <Text style={styles.cellText}>Unassigned</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setEmployeePicker(null)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
        <Modal visible={!!choicePicker} transparent animationType="fade" onRequestClose={() => setChoicePicker(null)}>
          <View style={styles.pickerBackdrop}>
            <View style={styles.picker}>
              <Text style={styles.sectionTitle}>Choose shift option</Text>
              {choicePicker?.choices.map((choice) => (
                <Pressable
                  key={choice.id}
                  style={styles.pickerOption}
                  onPress={() => {
                    if (choicePicker) {
                      setChoiceByCell((current) => ({ ...current, [choicePicker.key]: choice.id }));
                    }
                    setChoicePicker(null);
                  }}
                >
                  <Text style={styles.cellText}>{formatMasterTemplateChoice(choice)}</Text>
                </Pressable>
              ))}
              <Pressable
                style={styles.pickerOption}
                onPress={() => {
                  if (choicePicker) {
                    setChoiceByCell((current) => ({ ...current, [choicePicker.key]: '' }));
                  }
                  setChoicePicker(null);
                }}
              >
                <Text style={styles.cellText}>Keep current shift</Text>
              </Pressable>
              <Pressable style={styles.secondaryButton} onPress={() => setChoicePicker(null)}>
                <Text style={styles.secondaryText}>Cancel</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#f8fafc' },
  topBar: { padding: 18, paddingTop: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#fff' },
  title: { fontSize: 22, fontWeight: '700', color: '#0f172a' },
  close: { color: '#1d4ed8', fontWeight: '600' },
  tabs: { flexDirection: 'row', padding: 12, gap: 8, backgroundColor: '#fff' },
  tab: { paddingVertical: 9, paddingHorizontal: 12, borderRadius: 8, backgroundColor: '#e2e8f0' },
  tabActive: { backgroundColor: '#bfdbfe' },
  tabText: { color: '#0f172a', fontWeight: '600' },
  content: { padding: 16, gap: 12, paddingBottom: 40 },
  help: { color: '#475569', lineHeight: 20 },
  label: { color: '#334155', fontWeight: '700', marginTop: 8 },
  chipRow: { gap: 8, paddingVertical: 4 },
  chip: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 16, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: '#fff' },
  chipActive: { backgroundColor: '#dbeafe', borderColor: '#2563eb' },
  chipText: { color: '#0f172a' },
  tableContent: { paddingVertical: 4 },
  tableRow: { flexDirection: 'row', alignItems: 'stretch' },
  headerCell: { width: 155, minHeight: 54, padding: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#e2e8f0', fontWeight: '700', color: '#0f172a' },
  employeeCell: { width: 180 },
  cell: { width: 155, minHeight: 82, padding: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff' },
  cellText: { color: '#0f172a', lineHeight: 18 },
  muted: { color: '#64748b', fontSize: 12, marginTop: 3 },
  choiceButton: { marginTop: 5, padding: 5, backgroundColor: '#dbeafe', borderRadius: 5 },
  choiceText: { color: '#1d4ed8', fontSize: 11 },
  timeEditor: { flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 6 },
  timeInput: { width: 62, minHeight: 32, padding: 4, borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 5, backgroundColor: '#fff', color: '#0f172a', fontSize: 11 },
  timeSeparator: { color: '#64748b' },
  input: { borderWidth: 1, borderColor: '#cbd5e1', borderRadius: 8, backgroundColor: '#fff', padding: 11, color: '#0f172a' },
  primaryButton: { backgroundColor: '#1d4ed8', borderRadius: 8, padding: 12, alignItems: 'center' },
  primaryText: { color: '#fff', fontWeight: '700' },
  secondaryButton: { borderWidth: 1, borderColor: '#94a3b8', borderRadius: 8, padding: 10, alignItems: 'center', backgroundColor: '#fff' },
  secondaryText: { color: '#0f172a', fontWeight: '600' },
  masterSection: { gap: 8, marginTop: 10 },
  sectionTitle: { fontSize: 17, fontWeight: '700', color: '#0f172a' },
  masterHeaderCell: { width: 112, minHeight: 52, padding: 7, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#e2e8f0', fontWeight: '700', color: '#0f172a' },
  masterInput: { width: 112, minHeight: 52, padding: 7, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff', color: '#0f172a' },
  masterValue: { width: 112, minHeight: 52, padding: 10, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff', color: '#0f172a' },
  breakButton: { width: 112, minHeight: 52, padding: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff', justifyContent: 'center' },
  removeRowButton: { width: 86, minHeight: 52, padding: 8, borderWidth: 1, borderColor: '#cbd5e1', backgroundColor: '#fff', justifyContent: 'center' },
  pickerBackdrop: { flex: 1, justifyContent: 'center', padding: 18, backgroundColor: 'rgba(15,23,42,0.45)' },
  picker: { maxHeight: '80%', padding: 16, gap: 9, borderRadius: 12, backgroundColor: '#fff' },
  pickerOption: { padding: 12, borderWidth: 1, borderColor: '#e2e8f0', borderRadius: 8 },
});
