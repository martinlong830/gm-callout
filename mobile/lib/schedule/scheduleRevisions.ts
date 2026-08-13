import type { SupabaseClient } from '@supabase/supabase-js';

export type ScheduleRevisionSource =
  | 'persist'
  | 'publish'
  | 'hard_revert'
  | 'manual'
  | 'pre_revert';

export type ScheduleRevisionRow = {
  id: string;
  team_state_id: string;
  created_at: string;
  created_by: string | null;
  source: ScheduleRevisionSource;
  label: string | null;
  content_hash: string;
  schedule_assignments: unknown;
  draft_schedule: unknown;
  schedule_published?: unknown | null;
};

export const SCHEDULE_REVISION_RETENTION = 60;
/** Refuse remote schedule apply that differs from last successful push for this long. */
export const SCHEDULE_CONTENT_GUARD_MS = 90_000;

export function stableScheduleJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return 'null';
  }
}

/** Lightweight FNV-1a style hash for schedule bundle equality checks. */
export function hashScheduleBundle(assignments: unknown, draft: unknown): string {
  const raw = stableScheduleJson(assignments) + '\n' + stableScheduleJson(draft);
  let h = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    h ^= raw.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + String(raw.length);
}

export function formatScheduleRevisionLabel(
  source: ScheduleRevisionSource,
  when: Date = new Date()
): string {
  const time = when.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  if (source === 'publish') return `${time} · Publish`;
  if (source === 'hard_revert') return `${time} · Hard revert`;
  if (source === 'pre_revert') return `${time} · Before revert`;
  if (source === 'manual') return `${time} · Checkpoint`;
  return `${time} · Auto-save`;
}

export async function insertScheduleRevision(
  sb: SupabaseClient,
  opts: {
    teamStateId: string;
    userId?: string | null;
    source: ScheduleRevisionSource;
    assignments: unknown;
    draft: unknown;
    published?: unknown | null;
    label?: string | null;
    /** Skip insert when hash matches the newest revision. */
    dedupe?: boolean;
  }
): Promise<{ ok: boolean; id?: string; skipped?: boolean; error?: string }> {
  const teamStateId = String(opts.teamStateId || '').trim();
  if (!teamStateId) return { ok: false, error: 'missing team_state_id' };
  const contentHash = hashScheduleBundle(opts.assignments, opts.draft);
  try {
    if (opts.dedupe !== false) {
      const latest = await sb
        .from('team_state_schedule_revisions')
        .select('id, content_hash')
        .eq('team_state_id', teamStateId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!latest.error && latest.data && latest.data.content_hash === contentHash) {
        return { ok: true, skipped: true, id: latest.data.id as string };
      }
    }
    const row = {
      team_state_id: teamStateId,
      created_by: opts.userId || null,
      source: opts.source,
      label: opts.label || formatScheduleRevisionLabel(opts.source),
      content_hash: contentHash,
      schedule_assignments: opts.assignments ?? {},
      draft_schedule: opts.draft ?? {},
      schedule_published: opts.published ?? null,
    };
    const ins = await sb
      .from('team_state_schedule_revisions')
      .insert(row)
      .select('id')
      .single();
    if (ins.error) return { ok: false, error: ins.error.message };
    void pruneScheduleRevisions(sb, teamStateId);
    return { ok: true, id: ins.data?.id as string };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'insert failed' };
  }
}

export async function listScheduleRevisions(
  sb: SupabaseClient,
  teamStateId: string,
  limit = 40
): Promise<{ ok: boolean; rows: ScheduleRevisionRow[]; error?: string }> {
  const id = String(teamStateId || '').trim();
  if (!id) return { ok: false, rows: [], error: 'missing team_state_id' };
  try {
    const res = await sb
      .from('team_state_schedule_revisions')
      .select(
        'id, team_state_id, created_at, created_by, source, label, content_hash, schedule_assignments, draft_schedule, schedule_published'
      )
      .eq('team_state_id', id)
      .order('created_at', { ascending: false })
      .limit(Math.max(1, Math.min(100, limit)));
    if (res.error) return { ok: false, rows: [], error: res.error.message };
    return { ok: true, rows: (res.data || []) as ScheduleRevisionRow[] };
  } catch (e) {
    return { ok: false, rows: [], error: e instanceof Error ? e.message : 'list failed' };
  }
}

export async function fetchScheduleRevision(
  sb: SupabaseClient,
  revisionId: string
): Promise<{ ok: boolean; row?: ScheduleRevisionRow; error?: string }> {
  const id = String(revisionId || '').trim();
  if (!id) return { ok: false, error: 'missing revision id' };
  try {
    const res = await sb
      .from('team_state_schedule_revisions')
      .select(
        'id, team_state_id, created_at, created_by, source, label, content_hash, schedule_assignments, draft_schedule, schedule_published'
      )
      .eq('id', id)
      .maybeSingle();
    if (res.error) return { ok: false, error: res.error.message };
    if (!res.data) return { ok: false, error: 'Revision not found' };
    return { ok: true, row: res.data as ScheduleRevisionRow };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'fetch failed' };
  }
}

async function pruneScheduleRevisions(sb: SupabaseClient, teamStateId: string): Promise<void> {
  try {
    const res = await sb
      .from('team_state_schedule_revisions')
      .select('id')
      .eq('team_state_id', teamStateId)
      .order('created_at', { ascending: false })
      .range(SCHEDULE_REVISION_RETENTION, SCHEDULE_REVISION_RETENTION + 40);
    const ids = (res.data || []).map((r) => r.id).filter(Boolean);
    if (!ids.length) return;
    await sb.from('team_state_schedule_revisions').delete().in('id', ids);
  } catch {
    /* ignore retention failures */
  }
}
