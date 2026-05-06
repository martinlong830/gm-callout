import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
} from 'react-native';
import { useAppData } from '../contexts/AppDataContext';
import { useAuth } from '../contexts/AuthContext';
import { employeeDisplayName, staffTypeLabel } from '../lib/employees';
import {
  flushChatStoreSave,
  loadChatStore,
  queueChatStoreSave,
  subscribeChatStore,
  type ChatStore,
  type ChatThread,
} from '../lib/chatStore';
import { supabase } from '../lib/supabase';

const MANAGER_CONTACT = { id: 'msg-mgr', name: 'Martin Long', subtitle: 'Manager' };

type MessageRecipient = { id: string; name: string; subtitle: string };

type ListRow =
  | { key: string; kind: 'thread'; thread: ChatThread }
  | { key: string; kind: 'person'; recipient: MessageRecipient };

function threadHasMessages(t: ChatThread | undefined): boolean {
  return !!(t?.messages?.length);
}

function threadLastActivityMs(t: ChatThread): number {
  if (!threadHasMessages(t)) return 0;
  const last = t.messages[t.messages.length - 1];
  const ms = last?.at ? Date.parse(String(last.at)) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function sortThreadsByRecentDesc(threads: ChatThread[]): ChatThread[] {
  return [...threads].sort((a, b) => threadLastActivityMs(b) - threadLastActivityMs(a));
}

function threadsMatching(store: ChatStore, q: string): ChatThread[] {
  const query = q.trim().toLowerCase();
  const withMsg = store.threads.filter(threadHasMessages);
  if (!query) return sortThreadsByRecentDesc(withMsg);
  return sortThreadsByRecentDesc(
    withMsg.filter((t) => {
      const last = t.messages.length ? t.messages[t.messages.length - 1] : null;
      const preview = last ? last.body : '';
      const blob = `${t.peerName} ${t.subtitle || ''} ${preview}`.toLowerCase();
      return blob.includes(query);
    })
  );
}

function pickActiveAfterSync(remote: ChatStore, previousActive: string | null): string | null {
  if (remote.activeThreadId == null) return null;
  if (previousActive && remote.threads.some((t) => t.id === previousActive)) return previousActive;
  return remote.activeThreadId ?? null;
}

function stableThreadIdForRecipient(r: MessageRecipient): string {
  if (r.id === 'msg-mgr') return 'msg-mgr';
  return `msg-emp-${r.id}`;
}

function findThreadForRecipient(store: ChatStore, recipient: MessageRecipient): ChatThread | undefined {
  const tid = stableThreadIdForRecipient(recipient);
  const byId = store.threads.find((t) => t.id === tid);
  if (byId) return byId;
  const nm = recipient.name.trim().toLowerCase();
  return store.threads.find((t) => t.peerName.trim().toLowerCase() === nm);
}

function recipientHasMessagedThread(store: ChatStore, p: MessageRecipient): boolean {
  const t = findThreadForRecipient(store, p);
  return threadHasMessages(t);
}

function formatMessageBubbleTime(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function MessagesScreen() {
  const { user, displayName, role } = useAuth();
  const { employees } = useAppData();
  const uid = user?.id;
  const isFocused = useIsFocused();
  const isFocusedRef = useRef(isFocused);
  isFocusedRef.current = isFocused;
  /** While clearing inbox on tab focus; ignore remote activeThreadId until flush completes. */
  const resettingInboxRef = useRef(false);
  const [store, setStore] = useState<ChatStore | null>(null);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const applyRemoteStore = useCallback((remote: ChatStore) => {
    if (!isFocusedRef.current || resettingInboxRef.current) {
      setStore({ ...remote, activeThreadId: null });
      setActiveId(null);
      return;
    }
    setStore(remote);
    setActiveId(pickActiveAfterSync(remote, activeIdRef.current));
  }, []);

  const reloadFromServer = useCallback(async () => {
    if (!supabase || !uid) return;
    const s = await loadChatStore(supabase, uid);
    applyRemoteStore(s);
  }, [uid, applyRemoteStore]);

  useEffect(() => {
    if (!supabase || !uid) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const s = await loadChatStore(supabase, uid);
      if (!cancelled) {
        applyRemoteStore(s);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [uid, applyRemoteStore]);

  useEffect(() => {
    if (!supabase || !uid) return;
    return subscribeChatStore(supabase, uid, applyRemoteStore);
  }, [uid, applyRemoteStore]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      resettingInboxRef.current = true;
      setActiveId(null);
      setSearch('');
      setInput('');
      setStore((prev) => (prev ? { ...prev, activeThreadId: null } : prev));
      void (async () => {
        try {
          if (!supabase || !uid) return;
          const s = await loadChatStore(supabase, uid);
          if (cancelled) return;
          const inbox = { ...s, activeThreadId: null };
          setStore(inbox);
          setActiveId(null);
          setLoading(false);
          await flushChatStoreSave(supabase, uid, inbox);
        } finally {
          if (!cancelled) resettingInboxRef.current = false;
        }
      })();
      return () => {
        cancelled = true;
        resettingInboxRef.current = false;
      };
    }, [uid, supabase])
  );

  const persist = useCallback(
    (next: ChatStore) => {
      setStore(next);
      if (supabase && uid) queueChatStoreSave(supabase, uid, next);
    },
    [uid]
  );

  const messageRecipients = useMemo((): MessageRecipient[] => {
    const out: MessageRecipient[] = [];
    if (role === 'employee') {
      out.push(MANAGER_CONTACT);
    }
    const selfLower = displayName.trim().toLowerCase();
    for (const e of employees) {
      const n = employeeDisplayName(e);
      if (role === 'employee' && n.trim().toLowerCase() === selfLower) continue;
      out.push({ id: String(e.id), name: n, subtitle: staffTypeLabel(e.staffType) });
    }
    return out;
  }, [employees, role, displayName]);

  const listRows = useMemo((): ListRow[] => {
    if (!store) return [];
    const q = search.trim().toLowerCase();
    const rows: ListRow[] = [];
    const threadSlice = threadsMatching(store, search);
    threadSlice.forEach((t) => {
      rows.push({ key: `th-${t.id}`, kind: 'thread', thread: t });
    });
    if (!q) return rows;
    const matchedPeople = messageRecipients.filter((p) => {
      const blob = `${p.name} ${p.subtitle}`.toLowerCase();
      return blob.includes(q);
    });
    for (const p of matchedPeople) {
      if (recipientHasMessagedThread(store, p)) continue;
      rows.push({ key: `pe-${p.id}`, kind: 'person', recipient: p });
    }
    return rows;
  }, [store, search, messageRecipients]);

  const activeThread = useMemo(() => {
    if (!store || !activeId) return null;
    return store.threads.find((t) => t.id === activeId) ?? null;
  }, [store, activeId]);

  function openThread(id: string) {
    if (!store) return;
    persist({ ...store, activeThreadId: id });
    setActiveId(id);
  }

  function closeThread() {
    if (!store) return;
    persist({ ...store, activeThreadId: null });
    setActiveId(null);
  }

  async function openOrCreatePerson(recipient: MessageRecipient) {
    if (!store || !supabase || !uid) return;
    const found = findThreadForRecipient(store, recipient);
    if (found) {
      openThread(found.id);
      return;
    }
    const tid = stableThreadIdForRecipient(recipient);
    const thread: ChatThread = {
      id: tid,
      peerName: recipient.name,
      subtitle: recipient.subtitle,
      messages: [],
    };
    const next: ChatStore = {
      ...store,
      threads: [thread, ...store.threads],
      activeThreadId: tid,
    };
    setStore(next);
    setActiveId(tid);
    await flushChatStoreSave(supabase, uid, next);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !store || !activeId || !supabase || !uid) return;
    const threads = store.threads.map((t) => {
      if (t.id !== activeId) return t;
      return {
        ...t,
        messages: [
          ...t.messages,
          { who: 'self' as const, body: text, at: new Date().toISOString() },
        ],
      };
    });
    const next: ChatStore = { ...store, threads };
    setStore(next);
    setInput('');
    await flushChatStoreSave(supabase, uid, next);
  }

  if (!uid || !supabase) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Sign in to use messages.</Text>
      </View>
    );
  }

  if (loading || !store) {
    return (
      <View style={styles.centered}>
        <Text style={styles.muted}>Loading…</Text>
      </View>
    );
  }

  if (activeThread) {
    return (
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={64}
      >
        <View style={styles.chatHeader}>
          <Pressable onPress={closeThread} style={styles.backBtn}>
            <Text style={styles.backText}>Back</Text>
          </Pressable>
          <Text style={styles.chatTitle} numberOfLines={1}>
            {activeThread.peerName}
          </Text>
        </View>
        <FlatList
          style={styles.log}
          data={activeThread.messages}
          keyExtractor={(_, i) => String(i)}
          ListEmptyComponent={
            <Text style={styles.chatEmpty}>
              No messages yet. Type below to send your first message.
            </Text>
          }
          renderItem={({ item }) => {
            const timeLabel = formatMessageBubbleTime(item.at);
            return (
              <View style={[styles.bubble, item.who === 'self' ? styles.bubbleSelf : styles.bubblePeer]}>
                <Text style={styles.bubbleText}>{item.body}</Text>
                {timeLabel ? <Text style={styles.bubbleTime}>{timeLabel}</Text> : null}
              </View>
            );
          }}
        />
        <View style={styles.composer}>
          <TextInput
            style={styles.chatInput}
            value={input}
            onChangeText={setInput}
            placeholder="Write a message…"
            placeholderTextColor="#888"
          />
          <Pressable style={styles.sendBtn} onPress={sendMessage}>
            <Text style={styles.sendText}>Send</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    );
  }

  const q = search.trim();
  const emptyHint = q
    ? 'No conversations or team members match your search.'
    : 'Type in the search box to find a team member and start a conversation.';

  return (
    <View style={styles.flex}>
      <TextInput
        style={styles.search}
        value={search}
        onChangeText={setSearch}
        placeholder="Search conversations or team…"
        placeholderTextColor="#888"
      />
      <FlatList
        data={listRows}
        keyExtractor={(item) => item.key}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              setRefreshing(true);
              void reloadFromServer().finally(() => setRefreshing(false));
            }}
            tintColor="#c41230"
          />
        }
        ListEmptyComponent={<Text style={styles.muted}>{emptyHint}</Text>}
        renderItem={({ item }) => {
          if (item.kind === 'person') {
            const p = item.recipient;
            return (
              <Pressable style={[styles.threadRow, styles.threadRowPick]} onPress={() => void openOrCreatePerson(p)}>
                <Text style={styles.threadName}>{p.name}</Text>
                <Text style={styles.pickHint}>Start a conversation</Text>
                {p.subtitle ? <Text style={styles.threadSub}>{p.subtitle}</Text> : null}
              </Pressable>
            );
          }
          const t = item.thread;
          const last = t.messages?.length ? t.messages[t.messages.length - 1] : null;
          const previewText = last ? String(last.body || '') : '';
          return (
            <Pressable style={styles.threadRow} onPress={() => openThread(t.id)}>
              <Text style={styles.threadName}>{t.peerName}</Text>
              {t.subtitle ? <Text style={styles.threadSub}>{t.subtitle}</Text> : null}
              <Text style={styles.threadPreview} numberOfLines={2}>
                {previewText}
              </Text>
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: '#f4f6f8' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  muted: { color: '#666', padding: 16 },
  search: {
    marginHorizontal: 12,
    marginTop: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
    ...(Platform.OS === 'web'
      ? ({ outlineStyle: 'none', outlineWidth: 0 } as unknown as TextStyle)
      : {}),
  },
  threadRow: {
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
    backgroundColor: '#fff',
  },
  threadRowPick: { borderLeftWidth: 3, borderLeftColor: '#1e3a5f' },
  threadName: { fontSize: 16, fontWeight: '600', color: '#111' },
  threadSub: { fontSize: 12, color: '#888', marginTop: 2 },
  pickHint: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 4 },
  threadPreview: { fontSize: 13, color: '#666', marginTop: 4 },
  chatEmpty: {
    margin: 16,
    padding: 14,
    fontSize: 14,
    color: '#64748b',
    textAlign: 'center',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: '#e2e8f0',
    borderRadius: 8,
  },
  chatHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#e2e6ea',
    backgroundColor: '#fff',
  },
  backBtn: { paddingHorizontal: 12, paddingVertical: 8 },
  backText: { fontSize: 16, fontWeight: '600', color: '#c41230' },
  chatTitle: { flex: 1, textAlign: 'center', fontWeight: '600', fontSize: 16, marginRight: 48 },
  log: { flex: 1, padding: 12 },
  bubble: {
    maxWidth: '88%',
    paddingHorizontal: 10,
    paddingTop: 10,
    paddingBottom: 6,
    borderRadius: 12,
    marginBottom: 8,
  },
  bubblePeer: { alignSelf: 'flex-start', backgroundColor: '#eef1f4', borderWidth: 1, borderColor: '#dde2e8' },
  bubbleSelf: { alignSelf: 'flex-end', backgroundColor: '#dfe8f2', borderWidth: 1, borderColor: '#c9d6e8' },
  bubbleText: { fontSize: 15, color: '#222' },
  bubbleTime: {
    alignSelf: 'flex-end',
    marginTop: 6,
    fontSize: 11,
    fontWeight: '500',
    color: '#64748b',
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 10,
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: '#e2e6ea',
    backgroundColor: '#fff',
  },
  chatInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 16,
  },
  sendBtn: { backgroundColor: '#c41230', paddingHorizontal: 16, paddingVertical: 10, borderRadius: 8 },
  sendText: { color: '#fff', fontWeight: '600' },
});
