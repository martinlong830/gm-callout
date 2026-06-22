import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

const CHAT_STORE_CACHE_PREFIX = 'gm-chat-store-v1:';
const CHAT_STORE_CACHE_VERSION = 1;

export type ChatMessage = { who: 'self' | 'peer'; body: string; at: string };
export type ChatThread = {
  id: string;
  peerName: string;
  subtitle?: string;
  messages: ChatMessage[];
};

export type ChatStore = {
  version: 1;
  activeThreadId: string | null;
  threads: ChatThread[];
};

/** Legacy prompt flow created threads titled "New message" with junk bodies (e.g. "OK"). */
const LEGACY_NEW_MESSAGE_PEER = /^new\s*message$/i;

/** Empty threads — synced to Supabase so web/mobile share the same row (no placeholder welcome thread). */
export function emptyChatStore(): ChatStore {
  return { version: 1, activeThreadId: null, threads: [] };
}

export function parseChatStorePayloadRaw(raw: unknown): ChatStore | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<ChatStore>;
  if (o.version !== 1 || !Array.isArray(o.threads)) return null;
  return {
    version: 1,
    activeThreadId: o.activeThreadId ?? null,
    threads: o.threads,
  };
}

export function sanitizeChatStore(store: ChatStore): { next: ChatStore; changed: boolean } {
  const threads = store.threads.filter(
    (t) => t && !LEGACY_NEW_MESSAGE_PEER.test(String(t.peerName || '').trim())
  );
  let activeThreadId = store.activeThreadId;
  if (activeThreadId != null && !threads.some((t) => t.id === activeThreadId)) {
    activeThreadId = null;
  }
  const changed =
    threads.length !== store.threads.length || activeThreadId !== store.activeThreadId;
  return {
    next: { version: 1, activeThreadId, threads },
    changed,
  };
}

export function parseChatStorePayload(raw: unknown): ChatStore | null {
  const base = parseChatStorePayloadRaw(raw);
  if (!base) return null;
  return sanitizeChatStore(base).next;
}

function chatStoreCacheKey(userId: string): string {
  return `${CHAT_STORE_CACHE_PREFIX}${userId}`;
}

export async function readChatStoreCache(userId: string): Promise<ChatStore | null> {
  try {
    const raw = await AsyncStorage.getItem(chatStoreCacheKey(userId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { v?: number; store?: unknown };
    if (parsed?.v !== CHAT_STORE_CACHE_VERSION) return null;
    return parseChatStorePayload(parsed.store);
  } catch {
    return null;
  }
}

export async function writeChatStoreCache(userId: string, store: ChatStore): Promise<void> {
  try {
    await AsyncStorage.setItem(
      chatStoreCacheKey(userId),
      JSON.stringify({ v: CHAT_STORE_CACHE_VERSION, store })
    );
  } catch {
    // ignore cache write failures
  }
}

export async function loadChatStore(sb: SupabaseClient, userId: string): Promise<ChatStore> {
  const res = await sb.from('employee_chat_store').select('payload').eq('user_id', userId).maybeSingle();
  if (res.error) {
    console.warn('employee_chat_store select', res.error);
    return emptyChatStore();
  }
  if (!res.data) {
    const seed = emptyChatStore();
    void writeChatStoreCache(userId, seed);
    const up = await sb.from('employee_chat_store').upsert(
      { user_id: userId, payload: seed },
      { onConflict: 'user_id' }
    );
    if (up.error) console.warn('employee_chat_store seed', up.error);
    return seed;
  }
  const base = parseChatStorePayloadRaw(res.data.payload);
  if (base) {
    const { next, changed } = sanitizeChatStore(base);
    void writeChatStoreCache(userId, next);
    if (changed) void flushChatStoreSave(sb, userId, next);
    return next;
  }
  const seed = emptyChatStore();
  void writeChatStoreCache(userId, seed);
  const up = await sb.from('employee_chat_store').upsert(
    { user_id: userId, payload: seed },
    { onConflict: 'user_id' }
  );
  if (up.error) console.warn('employee_chat_store repair', up.error);
  return seed;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function runUpsert(sb: SupabaseClient, userId: string, store: ChatStore) {
  return sb.from('employee_chat_store').upsert({ user_id: userId, payload: store }, { onConflict: 'user_id' });
}

export function queueChatStoreSave(sb: SupabaseClient, userId: string, store: ChatStore) {
  void writeChatStoreCache(userId, store);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void runUpsert(sb, userId, store);
  }, 600);
}

/** Persist immediately (e.g. after send) so web / other devices see the message without waiting on debounce. */
export async function flushChatStoreSave(sb: SupabaseClient, userId: string, store: ChatStore): Promise<void> {
  void writeChatStoreCache(userId, store);
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const res = await runUpsert(sb, userId, store);
  if (res.error) console.warn('employee_chat_store upsert', res.error);
}

/**
 * Live sync when `employee_chat_store` changes (web app, another device, or manager viewing same row).
 * Requires Realtime enabled for `public.employee_chat_store` in Supabase (Dashboard → Database → Replication).
 */
export function subscribeChatStore(
  sb: SupabaseClient,
  userId: string,
  onRemote: (store: ChatStore) => void
): () => void {
  let remoteTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRemoteChatStore = (store: ChatStore) => {
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = setTimeout(() => {
      remoteTimer = null;
      onRemote(store);
    }, 400);
  };

  const channel: RealtimeChannel = sb
    .channel(`employee_chat_store:${userId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'employee_chat_store',
        filter: `user_id=eq.${userId}`,
      },
      (payload) => {
        const row = payload.new as { payload?: unknown } | null;
        if (!row || row.payload == null) return;
        const base = parseChatStorePayloadRaw(row.payload);
        if (!base) return;
        const { next, changed } = sanitizeChatStore(base);
        if (changed) void flushChatStoreSave(sb, userId, next);
        else void writeChatStoreCache(userId, next);
        scheduleRemoteChatStore(next);
      }
    )
    .subscribe();

  return () => {
    if (remoteTimer) clearTimeout(remoteTimer);
    void sb.removeChannel(channel);
  };
}
