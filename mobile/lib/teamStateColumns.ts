import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';

/** Schedule JSON only — largest egress columns. */
export const TEAM_STATE_SCHEDULE_COLUMNS =
  'schedule_assignments,schedule_templates,draft_schedule,updated_at';

export const TEAM_STATE_MANAGER_COLUMNS =
  TEAM_STATE_SCHEDULE_COLUMNS +
  ',messaging_templates,current_restaurant_id,callout_history,timeclock_settings,timecard_week_tip_pool,timecard_dishwasher_tips,timecard_week_extras';

export const TEAM_STATE_EMPLOYEE_COLUMNS =
  'schedule_assignments,callout_history,current_restaurant_id,updated_at';

const MANAGER_ALLOWED = [
  'schedule_assignments',
  'schedule_templates',
  'draft_schedule',
  'messaging_templates',
  'current_restaurant_id',
  'callout_history',
  'timeclock_settings',
  'timecard_week_tip_pool',
  'timecard_dishwasher_tips',
  'timecard_week_extras',
] as const;

const EMPLOYEE_ALLOWED = [
  'schedule_assignments',
  'callout_history',
  'current_restaurant_id',
] as const;

export function teamStateColumnsForRole(
  role: 'manager' | 'employee' | null | undefined,
  fields?: string[] | null
): string {
  const isManager = role === 'manager';
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
    role?: 'manager' | 'employee' | null;
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

/** Merge a partial remote row into cached team_state without dropping other columns. */
export function mergeTeamStatePartial(
  prev: Record<string, unknown> | null,
  partial: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (!partial) return prev;
  if (!prev) return { ...partial };
  return { ...prev, ...partial };
}
