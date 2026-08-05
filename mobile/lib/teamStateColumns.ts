import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { mergeDraftScheduleSlotOrderFromRemote } from './schedule/slotOrder';

/** Schedule JSON only — largest egress columns. */
export const TEAM_STATE_SCHEDULE_COLUMNS =
  'schedule_assignments,schedule_templates,draft_schedule,schedule_published,updated_at';

export const TEAM_STATE_MANAGER_COLUMNS =
  TEAM_STATE_SCHEDULE_COLUMNS +
  ',messaging_templates,current_restaurant_id,callout_history,timeclock_settings,timecard_week_tip_pool,timecard_dishwasher_tips,timecard_week_extras,timecard_tip_takehome_pct';

/** Employees need draft_schedule + schedule_published so views match manager SoT for published weeks. */
export const TEAM_STATE_EMPLOYEE_COLUMNS =
  'schedule_assignments,draft_schedule,schedule_published,callout_history,current_restaurant_id,updated_at';

const MANAGER_ALLOWED = [
  'schedule_assignments',
  'schedule_templates',
  'draft_schedule',
  'schedule_published',
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

export async function fetchTeamStateColumns(
  sb: SupabaseClient,
  opts: {
    role?: 'manager' | 'admin' | 'employee' | null;
    fields?: string[] | null;
    teamStateId?: string;
  }
): Promise<Record<string, unknown> | null> {
  const id = opts.teamStateId || (await readStoredTeamStateId());
  const cols = teamStateColumnsForRole(opts.role, opts.fields);
  const res = await sb.from('team_state').select(cols).eq('id', id).maybeSingle();
  if (res.error) {
    console.warn('team_state selective select', res.error);
    return null;
  }
  return res.data && typeof res.data === 'object'
    ? (res.data as Record<string, unknown>)
    : null;
}

/** In-memory only — never upsert to Supabase. Prefer local schedule while a save is pending. */
export const LOCAL_SCHEDULE_DIRTY_KEY = '__localScheduleDirty';

/** Merge a partial remote row into cached team_state without dropping other columns. */
export function mergeTeamStatePartial(
  prev: Record<string, unknown> | null,
  partial: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!partial) return prev;
  if (!prev) return { ...partial };
  const next: Record<string, unknown> = { ...prev, ...partial };
  const localDirty = prev[LOCAL_SCHEDULE_DIRTY_KEY] === true;

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
  if (localDirty) {
    if (prev.schedule_assignments != null) {
      next.schedule_assignments = prev.schedule_assignments;
    }
    if (prev.draft_schedule != null) {
      if (partial.draft_schedule != null) {
        next.draft_schedule = mergeDraftScheduleSlotOrderFromRemote(
          partial.draft_schedule,
          prev.draft_schedule
        );
      } else {
        next.draft_schedule = prev.draft_schedule;
      }
    }
    next[LOCAL_SCHEDULE_DIRTY_KEY] = true;
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
