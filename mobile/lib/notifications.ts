import type { SupabaseClient } from '@supabase/supabase-js';

export type AppNotification = {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
  restaurant_id?: string | null;
};

export async function fetchAppNotifications(
  sb: SupabaseClient,
  userId: string,
  limit = 50
): Promise<{ ok: true; rows: AppNotification[] } | { ok: false; message: string }> {
  const res = await sb
    .from('app_notifications')
    .select('id, type, title, body, data, read_at, created_at, restaurant_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (res.error) {
    return { ok: false, message: res.error.message || 'Could not load notifications.' };
  }
  return { ok: true, rows: (res.data || []) as AppNotification[] };
}

export async function markNotificationsRead(
  sb: SupabaseClient,
  userId: string,
  ids: string[]
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!ids.length) return { ok: true };
  const now = new Date().toISOString();
  const res = await sb
    .from('app_notifications')
    .update({ read_at: now })
    .eq('user_id', userId)
    .in('id', ids)
    .is('read_at', null);
  if (res.error) return { ok: false, message: res.error.message || 'Could not mark read.' };
  return { ok: true };
}

export async function markAllNotificationsRead(
  sb: SupabaseClient,
  userId: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const now = new Date().toISOString();
  const res = await sb
    .from('app_notifications')
    .update({ read_at: now })
    .eq('user_id', userId)
    .is('read_at', null);
  if (res.error) return { ok: false, message: res.error.message || 'Could not mark all read.' };
  return { ok: true };
}
