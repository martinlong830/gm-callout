import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const CHANNEL_PREFIX = 'app_notifications_mobile';

type Listener = () => void;

let activeClient: SupabaseClient | null = null;
let activeUserId: string | null = null;
let channel: RealtimeChannel | null = null;
let channelGeneration = 0;
const listeners = new Set<Listener>();

function notifyListeners() {
  for (const listener of listeners) {
    try {
      listener();
    } catch (err) {
      console.warn('app_notifications listener', err);
    }
  }
}

function tearDownChannel() {
  if (channel && activeClient) {
    void activeClient.removeChannel(channel);
  }
  channel = null;
  activeClient = null;
  activeUserId = null;
}

function ensureChannel(sb: SupabaseClient, userId: string) {
  if (channel && activeClient === sb && activeUserId === userId) return;

  tearDownChannel();

  activeClient = sb;
  activeUserId = userId;
  channelGeneration += 1;
  // Unique topic per setup so we never call .on() on a channel that is already
  // subscribed (supabase-js reuses by topic name and throws after subscribe()).
  const name = `${CHANNEL_PREFIX}:${userId}:${channelGeneration}`;
  // All .on() callbacks must be registered before subscribe().
  channel = sb
    .channel(name)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'app_notifications',
        filter: `user_id=eq.${userId}`,
      },
      () => {
        notifyListeners();
      }
    )
    .subscribe();
}

/**
 * Shared Realtime subscription for app_notifications.
 * Multiple NotificationBellButton mounts (one per tab header) share one channel;
 * calling .channel(sameName).on() after subscribe() throws otherwise.
 */
export function subscribeAppNotificationsMobile(
  sb: SupabaseClient,
  userId: string,
  onChange: Listener
): () => void {
  listeners.add(onChange);
  ensureChannel(sb, userId);

  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) {
      tearDownChannel();
    }
  };
}
