import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { mergeDraftScheduleSlotOrderFromRemote } from './schedule/slotOrder';

/** Schedule JSON only — largest egress columns. */
export const TEAM_STATE_SCHEDULE_COLUMNS =
  'schedule_assignments,schedule_templates,draft_schedule,schedule_published,company_holidays,updated_at';

export const TEAM_STATE_MANAGER_COLUMNS =
  TEAM_STATE_SCHEDULE_COLUMNS +
  ',messaging_templates,current_restaurant_id,callout_history,timeclock_settings,timecard_week_tip_pool,timecard_dishwasher_tips,timecard_week_extras,timecard_tip_takehome_pct';

/** Employees need draft_schedule + schedule_published so views match manager SoT for published weeks. */
export const TEAM_STATE_EMPLOYEE_COLUMNS =
  'schedule_assignments,draft_schedule,schedule_published,company_holidays,callout_history,current_restaurant_id,updated_at';

const MANAGER_ALLOWED = [
  'schedule_assignments',
  'schedule_templates',
  'draft_schedule',
  'schedule_published',
  'company_holidays',
  'messaging_templates',
  'current_restaurant_id',
  'callout_history',
  'timeclock_settings',
  'timecard_week_tip_pool',
  'timecard_dishwasher_tips',
  'timecard_week_extras',
  'timecard_tip_takehome_pct',
] as const;

const EMPLOYEE_ALLOWED = [
  'schedule_assignments',
  'draft_schedule',
  'schedule_published',
  'company_holidays',
  'callout_history',
  'current_restaurant_id',
] as const;

export function teamStateColumnsForRole(
  role: 'manager' | 'admin' | 'employee' | null | undefined,
  fields?: string[] | null
): string {
  const isManager = role === 'manager' || role === 'admin';
  if (Array.isArray(fields) && fields.length) {
    const set = new Set(fields.map((f) => String(f)));
    const cols = ['updated_at'];
    const allowed = isManager ? MANAGER_ALLOWED : EMPLOYEE_ALLOWED;
    for (const c of allowed) {
      if (set.has(c)) cols.push(c);
    }
    if (cols.length === 1) {
      return isManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
    }
    return cols.join(',');
  }
  return isManager ? TEAM_STATE_MANAGER_COLUMNS : TEAM_STATE_EMPLOYEE_COLUMNS;
}

/** Cheap probe — avoid downloading multi-MB JSON when nothing changed. */
export async function fetchTeamStateUpdatedAt(
  sb: SupabaseClient,
  teamStateId?: string
): Promise<string | null> {
  const id = teamStateId || (await readStoredTeamStateId());
  const res = await sb.from('team_state').select('updated_at').eq('id', id).maybeSingle();
  if (res.error || !res.data) return null;
  const at = res.data.updated_at;
  return at != null ? String(at) : null;
}

const MISSING_COLS_KEY = 'gm-callout-team-state-missing-cols-v1';

/** Seed columns known missing until production migrations are applied. */
const seededMissing: Record<string, true> = {
  company_holidays: true,
  schedule_reviews: true,
  timecard_tip_takehome_pct: true,
};

function loadMissingColumns(): Record<string, true> {
  const out: Record<string, true> = { ...seededMissing };
  try {
    if (typeof localStorage === 'undefined') return out;
    const raw = localStorage.getItem(MISSING_COLS_KEY);
    if (!raw) return out;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      for (const k of Object.keys(parsed)) {
        if (parsed[k]) out[k] = true;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

let missingColumns = loadMissingColumns();

function persistMissingColumns() {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(MISSING_COLS_KEY, JSON.stringify(missingColumns));
  } catch {
    /* ignore */
  }
}

function markColumnMissing(col: string) {
  const c = String(col || '').trim();
  if (!c || missingColumns[c]) return;
  missingColumns = { ...missingColumns, [c]: true };
  persistMissingColumns();
}

function stripMissingColumns(colsCsv: string): string {
  return String(colsCsv || '')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c && !missingColumns[c])
    .join(',');
}

function parseMissingColumnFromError(err: unknown): string {
  const msg = String(
    (err && typeof err === 'object' && 'message' in err && (err as { message?: string }).message) ||
      err ||
      ''
  );
  const m =
    msg.match(/column\s+[\w.]+\.(\w+)\s+does not exist/i) ||
    msg.match(/Could not find the '(\w+)' column/i);
  return m && m[1] ? m[1] : '';
}

export async function fetchTeamStateColumns(
  sb: SupabaseClient,
  opts: {
    role?: 'manager' | 'admin' | 'employee' | null;
    fields?: string[] | null;
    teamStateId?: string;
  }
): Promise<Record<string, unknown> | null> {
  const id = opts.teamStateId || (await readStoredTeamStateId());
  let cols = stripMissingColumns(teamStateColumnsForRole(opts.role, opts.fields));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const res = await sb.from('team_state').select(cols).eq('id', id).maybeSingle();
    if (!res.error) {
      return res.data && typeof res.data === 'object'
        ? (res.data as Record<string, unknown>)
        : null;
    }
    const missing = parseMissingColumnFromError(res.error);
    if (!missing) {
      console.warn('team_state selective select', res.error);
      return null;
    }
    markColumnMissing(missing);
    const next = stripMissingColumns(cols);
    if (!next || next === cols) {
      console.warn('team_state selective select', res.error);
      return null;
    }
    cols = next;
  }
  return null;
}

/** In-memory only — never upsert to Supabase. Prefer local schedule while a save is pending. */
export const LOCAL_SCHEDULE_DIRTY_KEY = '__localScheduleDirty';

/**
 * Prefer local schedule while dirty, or while a local upsert is still in flight / just
 * finished (caller passes protectLocal). Parity with web teamStateAssignmentMergeLocked.
 */
export function mergeTeamStatePartial(
  prev: Record<string, unknown> | null,
  partial: Record<string, unknown> | null,
  opts?: { protectLocalSchedule?: boolean }
): Record<string, unknown> | null {
  if (!partial) return prev;
  if (!prev) return { ...partial };
  const next: Record<string, unknown> = { ...prev, ...partial };
  const localDirty = prev[LOCAL_SCHEDULE_DIRTY_KEY] === true;
  const protectLocal = localDirty || !!opts?.protectLocalSchedule;

  /*
   * Prefer remote Manager SoT unless this device has unsaved schedule edits.
   * Do not use client-bumped updated_at alone — that blocked newer web pushes forever.
   * Do not compare timestamps either: the local cache keeps the updated_at of the last
   * snapshot it read, so every remote row looks newer once this device has pushed once,
   * which let a snapshot taken before the pending edit win. Web does the same thing via
   * `teamStateAssignmentMergeLocked()` — while local edits are unsaved, remote schedule
   * columns are skipped entirely (the row's updated_at is still adopted so freshness
   * probes keep working). When dirty, keep BOTH assignments + draft together (never mix
   * stale remote people with local times or the reverse).
   */
  if (protectLocal) {
    if (prev.schedule_assignments != null) {
      next.schedule_assignments = prev.schedule_assignments;
    }
    if (prev.draft_schedule != null) {
      /*
       * While dirty/in-flight, keep local draft times AND people together.
       * Do not merge remote slot-order into a dirty draft — that mixed peer structure
       * with local people and looked like a rollback / corruption.
       */
      next.draft_schedule = prev.draft_schedule;
    }
    if (prev.schedule_published != null && partial.schedule_published != null) {
      /* Published flags can update; they do not discard assignment edits. */
      next.schedule_published = partial.schedule_published;
    }
    if (localDirty) next[LOCAL_SCHEDULE_DIRTY_KEY] = true;
    /* Always adopt remote updated_at so freshness probes stay honest. */
    if (partial.updated_at != null) next.updated_at = partial.updated_at;
    return next;
  }

  if (
    Object.prototype.hasOwnProperty.call(partial, 'draft_schedule') &&
    partial.draft_schedule != null &&
    prev.draft_schedule != null
  ) {
    next.draft_schedule = mergeDraftScheduleSlotOrderFromRemote(
      prev.draft_schedule,
      partial.draft_schedule
    );
  }
  delete next[LOCAL_SCHEDULE_DIRTY_KEY];
  return next;
}
