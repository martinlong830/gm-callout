import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * Live sync when `team_state` changes (schedule, tip pool, dishwasher tips, etc.).
 * Requires Realtime enabled for `public.team_state` in Supabase.
 */
export function subscribeTeamState(
  sb: SupabaseClient,
  onRemoteChange: () => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRemoteChange();
    }, 350);
  };

  const channel: RealtimeChannel = sb
    .channel('team_state_main')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'team_state', filter: 'id=eq.main' },
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
