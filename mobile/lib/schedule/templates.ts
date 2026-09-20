export const TEMPLATE_SECTION_KEYS = ['FOH', 'BOH', 'Delivery/Dishwasher'] as const;

export type TemplateSectionKey = (typeof TEMPLATE_SECTION_KEYS)[number];
export type MasterBreakType = '30' | 'none';

export type MasterTemplateRow = {
  id: string;
  role: string;
  shift: string;
  clockIn: string;
  clockOut: string;
  break: MasterBreakType;
  totalHours: number;
  hoursAfterBreak: number;
  daysPerWeek: string;
};

export type MasterTemplate = {
  id: string;
  kind: 'master';
  name: string;
  createdAt: string;
  sections: Record<TemplateSectionKey, MasterTemplateRow[]>;
};

export type NormalTemplate = {
  id: string;
  kind?: 'normal';
  name: string;
  createdAt?: string;
  masterTemplateId?: string;
  [key: string]: unknown;
};

export type ScheduleTemplate = MasterTemplate | NormalTemplate;

const DEFAULT_SECTION_ROWS: Record<TemplateSectionKey, MasterTemplateRow[]> = {
  FOH: [],
  BOH: [],
  'Delivery/Dishwasher': [],
};

function asText(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function makeId(prefix: string, index: number): string {
  return `${prefix}-${Date.now().toString(36)}-${index.toString(36)}`;
}

function normalizeBreak(value: unknown): MasterBreakType {
  const text = asText(value).toLowerCase();
  return text === '30' || text === '30 minutes' || text === '30-min' ? '30' : 'none';
}

function parseTime(value: unknown): number | null {
  const match = asText(value).match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export function calculateMasterShiftHours(clockIn: unknown, clockOut: unknown): number {
  const start = parseTime(clockIn);
  const end = parseTime(clockOut);
  if (start == null || end == null) return 0;
  let minutes = end - start;
  if (minutes <= 0) minutes += 24 * 60;
  return Math.round((minutes / 60) * 100) / 100;
}

export function calculateMasterHoursAfterBreak(
  clockIn: unknown,
  clockOut: unknown,
  breakType: unknown
): number {
  const total = calculateMasterShiftHours(clockIn, clockOut);
  return Math.max(0, Math.round((total - (normalizeBreak(breakType) === '30' ? 0.5 : 0)) * 100) / 100);
}

export function normalizeMasterTemplateRow(raw: unknown, index = 0): MasterTemplateRow {
  const row = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const clockIn = asText(row.clockIn ?? row.start);
  const clockOut = asText(row.clockOut ?? row.end);
  const breakType = normalizeBreak(row.break);
  const totalHours = calculateMasterShiftHours(clockIn, clockOut);
  return {
    id: asText(row.id) || makeId('master-row', index),
    role: asText(row.role),
    shift: asText(row.shift),
    clockIn,
    clockOut,
    break: breakType,
    totalHours,
    hoursAfterBreak: calculateMasterHoursAfterBreak(clockIn, clockOut, breakType),
    daysPerWeek: asText(row.daysPerWeek ?? row.daysWk),
  };
}

export function emptyMasterTemplateSections(): Record<TemplateSectionKey, MasterTemplateRow[]> {
  return {
    FOH: [...DEFAULT_SECTION_ROWS.FOH],
    BOH: [...DEFAULT_SECTION_ROWS.BOH],
    'Delivery/Dishwasher': [...DEFAULT_SECTION_ROWS['Delivery/Dishwasher']],
  };
}

export function normalizeMasterTemplate(raw: unknown): MasterTemplate | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (value.kind !== 'master') return null;
  const rawSections =
    value.sections && typeof value.sections === 'object'
      ? (value.sections as Record<string, unknown>)
      : {};
  const sections = emptyMasterTemplateSections();
  TEMPLATE_SECTION_KEYS.forEach((section) => {
    const rows = Array.isArray(rawSections[section]) ? rawSections[section] : [];
    sections[section] = rows.map((row, index) => normalizeMasterTemplateRow(row, index));
  });
  return {
    id: asText(value.id) || makeId('master', 0),
    kind: 'master',
    name: asText(value.name) || 'Untitled Master Template',
    createdAt: asText(value.createdAt) || new Date().toISOString(),
    sections,
  };
}

export function isMasterTemplate(raw: unknown): raw is MasterTemplate {
  return !!normalizeMasterTemplate(raw);
}

export function normalizeScheduleTemplates(raw: unknown): ScheduleTemplate[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry, index) => {
      const master = normalizeMasterTemplate(entry);
      if (master) return master;
      if (!entry || typeof entry !== 'object') return null;
      const value = entry as Record<string, unknown>;
      const id = asText(value.id) || makeId('template', index);
      const name = asText(value.name) || 'Untitled Template';
      return {
        ...value,
        id,
        name,
        kind: value.kind === 'normal' ? 'normal' : undefined,
      } as NormalTemplate;
    })
    .filter((entry): entry is ScheduleTemplate => !!entry);
}

function cloneTemplateEntry(entry: unknown): ScheduleTemplate | null {
  try {
    return JSON.parse(JSON.stringify(entry)) as ScheduleTemplate;
  } catch {
    return null;
  }
}

/**
 * Union local + remote named templates by id. A stale/smaller cloud list must
 * not delete templates this device still has (deploy / hard-refresh / idle poll).
 */
export function mergeScheduleTemplateLibraries(
  localArr: unknown,
  remoteArr: unknown,
  preferLocalOverlap = false
): { list: ScheduleTemplate[]; needRepush: boolean } {
  const local = Array.isArray(localArr) ? localArr : [];
  const remote = Array.isArray(remoteArr) ? remoteArr : [];
  const byId = new Map<string, ScheduleTemplate>();
  const ingest = (raw: unknown, overwrite: boolean) => {
    const copy = cloneTemplateEntry(raw);
    if (!copy || typeof copy !== 'object') return;
    const id = asText((copy as { id?: unknown }).id) || makeId('template', byId.size);
    (copy as { id: string }).id = id;
    if (overwrite || !byId.has(id)) byId.set(id, copy);
  };
  if (preferLocalOverlap) {
    remote.forEach((entry) => ingest(entry, true));
    local.forEach((entry) => ingest(entry, true));
  } else {
    local.forEach((entry) => ingest(entry, true));
    remote.forEach((entry) => ingest(entry, true));
  }
  const list = Array.from(byId.values());
  const remoteIds = new Set(
    remote
      .map((entry) =>
        entry && typeof entry === 'object' ? asText((entry as { id?: unknown }).id) : ''
      )
      .filter(Boolean)
  );
  const localIdsMissingFromRemote = local.some((entry) => {
    const id =
      entry && typeof entry === 'object' ? asText((entry as { id?: unknown }).id) : '';
    return !!id && !remoteIds.has(id);
  });
  const needRepush = (!remote.length && local.length > 0) || localIdsMissingFromRemote;
  return { list, needRepush };
}

export function templateSectionForRole(role: string): TemplateSectionKey {
  if (role === 'Kitchen' || role === 'BOH') return 'BOH';
  if (role === 'Server' || role === 'Delivery/Dishwasher') return 'Delivery/Dishwasher';
  return 'FOH';
}

export function masterTemplateRowsForRole(
  template: MasterTemplate | null | undefined,
  role: string
): MasterTemplateRow[] {
  if (!template) return [];
  return template.sections[templateSectionForRole(role)] || [];
}

export function formatMasterTemplateChoice(row: MasterTemplateRow): string {
  const time = row.clockIn && row.clockOut ? `${row.clockIn}–${row.clockOut}` : 'No time';
  const days = row.daysPerWeek ? ` · ${row.daysPerWeek} days/wk` : '';
  return `${row.role || 'Unspecified role'} · ${row.shift || 'Unspecified shift'} · ${time}${days}`;
}

function assignmentWorkers(entry: unknown): string[] {
  if (Array.isArray(entry)) {
    return entry.map((n) => asText(n)).filter((n) => n && n !== 'Unassigned');
  }
  if (entry && typeof entry === 'object') {
    const workers = (entry as { workers?: unknown }).workers;
    if (Array.isArray(workers)) {
      return workers.map((n) => asText(n)).filter((n) => n && n !== 'Unassigned');
    }
  }
  return [];
}

function weekPatternFromAssignmentSlice(rs: Record<string, unknown>): Record<string, unknown> {
  const staffedByWeek = new Map<number, number>();
  Object.keys(rs).forEach((shiftId) => {
    const match = shiftId.match(/^shift-(\d+)-\d+-\d+$/);
    if (!match) return;
    if (!assignmentWorkers(rs[shiftId]).length) return;
    const weekIndex = Math.floor(Number(match[1]) / 7);
    staffedByWeek.set(weekIndex, (staffedByWeek.get(weekIndex) || 0) + 1);
  });
  let bestWeek = 0;
  let bestCount = -1;
  staffedByWeek.forEach((count, weekIndex) => {
    if (count > bestCount) {
      bestCount = count;
      bestWeek = weekIndex;
    }
  });
  const weekStart = bestWeek * 7;
  const out: Record<string, unknown> = {};
  Object.keys(rs).forEach((shiftId) => {
    const match = shiftId.match(/^shift-(\d+)-(\d+)-(\d+)$/);
    if (!match) return;
    const day = Number(match[1]);
    if (day < weekStart || day >= weekStart + 7) return;
    const entry = rs[shiftId];
    out[`${day - weekStart}-${Number(match[2])}-${Number(match[3])}`] = Array.isArray(entry)
      ? { workers: entry }
      : entry;
  });
  return out;
}

function weekPatternHasStaffedSlots(pattern: Record<string, unknown>): boolean {
  return Object.keys(pattern).some((key) => assignmentWorkers(pattern[key]).length > 0);
}

/** Resolve a saved template into Mon–Sun relative keys, including legacy assignment slices. */
export function weekPatternFromScheduleTemplate(
  template: NormalTemplate,
  restaurantId: string
): Record<string, unknown> {
  const raw =
    template.weekPattern && typeof template.weekPattern === 'object'
      ? (template.weekPattern as Record<string, unknown>)
      : {};
  if (weekPatternHasStaffedSlots(raw)) return raw;
  const assigns =
    template.assignments && typeof template.assignments === 'object'
      ? (template.assignments as Record<string, Record<string, unknown>>)
      : null;
  if (!assigns) return raw;
  const restaurantIds = [
    restaurantId,
    ...Object.keys(assigns).filter((id) => id !== restaurantId),
  ];
  for (const id of restaurantIds) {
    const slice = assigns[id];
    if (!slice || typeof slice !== 'object') continue;
    const built = weekPatternFromAssignmentSlice(slice);
    if (weekPatternHasStaffedSlots(built)) return built;
  }
  return raw;
}
