import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * Live sync when `time_clock_entries` change (kiosk punches, manager edits).
 * Requires Realtime enabled for `public.time_clock_entries` in Supabase.
 */
export function subscribeTimeClockEntries(
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
    .channel('time_clock_entries_team')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'time_clock_entries' },
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
