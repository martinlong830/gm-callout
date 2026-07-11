import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

export type TeamStateBroadcastPayload = {
  source?: string;
  fields?: string[];
  ts?: number;
};

const TEAM_STATE_BROADCAST_EVENT = 'team_state_changed';
const REMOTE_REFRESH_DEBOUNCE_MS = 1200;

let sharedChannel: RealtimeChannel | null = null;
let sharedTeamStateId: string | null = null;

/**
 * Lightweight team_state sync: broadcast ping (~100 bytes) + debounced REST refetch.
 * Replaces postgres_changes on team_state (full-row Realtime egress on every UPDATE).
 */
export function subscribeTeamState(
  sb: SupabaseClient,
  teamStateId: string,
  onRemoteChange: (fields?: string[]) => void
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const queue = (fields?: string[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onRemoteChange(fields);
    }, REMOTE_REFRESH_DEBOUNCE_MS);
  };

  const channel: RealtimeChannel = sb
    .channel(`team_state_sync_${teamStateId}`, {
      config: { broadcast: { ack: false, self: true } },
    })
    .on('broadcast', { event: TEAM_STATE_BROADCAST_EVENT }, ({ payload }) => {
      const p = payload as TeamStateBroadcastPayload | undefined;
      queue(Array.isArray(p?.fields) ? p.fields : undefined);
    })
    .subscribe();

  sharedChannel = channel;
  sharedTeamStateId = teamStateId;

  return () => {
    if (timer) clearTimeout(timer);
    if (sharedChannel === channel) {
      sharedChannel = null;
      sharedTeamStateId = null;
    }
    void sb.removeChannel(channel);
  };
}

/** Notify other clients after a successful team_state upsert (manager web/mobile). */
export async function broadcastTeamStateChanged(
  sb: SupabaseClient,
  teamStateId: string,
  fields: string[],
  sourceUserId?: string | null
): Promise<void> {
  const payload = {
    source: sourceUserId || undefined,
    fields,
    ts: Date.now(),
  };

  if (sharedChannel && sharedTeamStateId === teamStateId) {
    try {
      await sharedChannel.send({
        type: 'broadcast',
        event: TEAM_STATE_BROADCAST_EVENT,
        payload,
      });
      return;
    } catch {
      /* fall through to ephemeral channel */
    }
  }

  const channel = sb.channel(`team_state_sync_${teamStateId}`, {
    config: { broadcast: { ack: false, self: true } },
  });
  await channel.subscribe();
  try {
    await channel.send({
      type: 'broadcast',
      event: TEAM_STATE_BROADCAST_EVENT,
      payload,
    });
  } finally {
    void sb.removeChannel(channel);
  }
}
