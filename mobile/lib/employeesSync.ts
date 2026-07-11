import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * Live sync when `employees` changes (web app or another device).
 * Requires Realtime enabled for `public.employees` in Supabase (Dashboard → Database → Replication).
 */
export function subscribeEmployees(
  sb: SupabaseClient,
  onRemoteChange: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRemoteChange();
    }, 800);
  };

  const channel: RealtimeChannel = sb
    .channel('employees_team')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'employees' },
      () => {
        queue();
      }
    )
    .subscribe();

  return () => {
    if (timer) clearTimeout(timer);
    void sb.removeChannel(channel);
  };
}
