import type { SupabaseClient } from '@supabase/supabase-js';
import { readStoredTeamStateId } from './companySession';
import { broadcastTeamStateChanged } from './teamStateSync';

export type CompanyHoliday = {
  id: string;
  /** Local calendar date YYYY-MM-DD */
  iso: string;
  name: string;
};

export type CompanyHolidaysPayload = {
  v: 1;
  holidays: CompanyHoliday[];
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

function newHolidayId(): string {
  return `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeCompanyHolidays(raw: unknown): CompanyHoliday[] {
  if (!raw) return [];
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.holidays)) list = o.holidays;
  }
  const out: CompanyHoliday[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const iso = String(row.iso || '').slice(0, 10);
    if (!ISO_RE.test(iso) || seen.has(iso)) continue;
    const name = String(row.name || '').trim() || 'Holiday';
    const id = String(row.id || '').trim() || newHolidayId();
    seen.add(iso);
    out.push({ id, iso, name });
  }
  out.sort((a, b) => a.iso.localeCompare(b.iso));
  return out;
}

export function companyHolidaysPayload(list: CompanyHoliday[]): CompanyHolidaysPayload {
  return { v: 1, holidays: normalizeCompanyHolidays(list) };
}

export function holidayOnIso(list: CompanyHoliday[], iso: string): CompanyHoliday | null {
  const key = String(iso || '').slice(0, 10);
  if (!ISO_RE.test(key)) return null;
  return list.find((h) => h.iso === key) || null;
}

/** Inclusive window: today … today + (days - 1). Default 28 days (4 weeks). */
export function upcomingHolidaysInWindow(
  list: CompanyHoliday[],
  opts?: { fromIso?: string; days?: number }
): CompanyHoliday[] {
  const days = opts?.days != null && opts.days > 0 ? Math.floor(opts.days) : 28;
  const from = opts?.fromIso && ISO_RE.test(opts.fromIso) ? opts.fromIso : localTodayIso();
  const end = addDaysIso(from, days - 1);
  return normalizeCompanyHolidays(list).filter((h) => h.iso >= from && h.iso <= end);
}

export function localTodayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDaysIso(iso: string, delta: number): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  d.setDate(d.getDate() + delta);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

export function upsertCompanyHoliday(
  list: CompanyHoliday[],
  input: { iso: string; name: string; id?: string }
): CompanyHoliday[] {
  const iso = String(input.iso || '').slice(0, 10);
  if (!ISO_RE.test(iso)) return list;
  const name = String(input.name || '').trim() || 'Holiday';
  const id = String(input.id || '').trim() || newHolidayId();
  const next = normalizeCompanyHolidays(list).filter((h) => h.iso !== iso);
  next.push({ id, iso, name });
  return normalizeCompanyHolidays(next);
}

export function removeCompanyHoliday(list: CompanyHoliday[], idOrIso: string): CompanyHoliday[] {
  const key = String(idOrIso || '').trim();
  return normalizeCompanyHolidays(list).filter((h) => h.id !== key && h.iso !== key);
}

export async function persistCompanyHolidays(
  sb: SupabaseClient,
  list: CompanyHoliday[]
): Promise<
  | { ok: true; payload: CompanyHolidaysPayload; updatedAt?: string }
  | { ok: false; message: string }
> {
  const teamStateId = await readStoredTeamStateId();
  const payload = companyHolidaysPayload(list);
  const up = await sb
    .from('team_state')
    .upsert(
      {
        id: teamStateId,
        company_holidays: payload,
      },
      { onConflict: 'id' }
    )
    .select('id, updated_at')
    .single();
  if (up.error) return { ok: false, message: up.error.message };
  try {
    await broadcastTeamStateChanged(sb, teamStateId, ['company_holidays']);
  } catch {
    /* non-blocking */
  }
  return {
    ok: true,
    payload,
    updatedAt: up.data?.updated_at != null ? String(up.data.updated_at) : undefined,
  };
}

/** e.g. "Mon Dec 25" */
export function formatHolidayDateLabel(iso: string): string {
  const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return iso;
  const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
  if (Number.isNaN(d.getTime())) return iso;
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${WEEKDAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
