import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * Live sync when `staff_requests` changes (submissions, swap offers, manager approvals).
 * Requires Realtime enabled for `public.staff_requests` in Supabase.
 */
export function subscribeStaffRequests(
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
    .channel('staff_requests_team')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'staff_requests' },
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
