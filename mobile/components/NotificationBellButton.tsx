import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/LocaleContext';
import {
  fetchAppNotifications,
  markAllNotificationsRead,
  markNotificationsRead,
  type AppNotification,
} from '../lib/notifications';
import { hrefForNotificationRoute, resolveNotificationRoute } from '../lib/notificationRoutes';
import { supabase } from '../lib/supabase';

function formatWhen(iso: string, locale: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleString(locale === 'es' ? 'es' : 'en', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

export function NotificationBellButton() {
  const { session, role } = useAuth();
  const { t, locale } = useI18n();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<AppNotification[]>([]);

  const userId = session?.user?.id || null;
  const unread = useMemo(() => items.filter((n) => !n.read_at).length, [items]);

  const refresh = useCallback(async () => {
    if (!supabase || !userId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const res = await fetchAppNotifications(supabase, userId);
      if (res.ok) setItems(res.rows);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!supabase || !userId) return;
    const channel = supabase
      .channel('app_notifications_mobile')
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'app_notifications',
          filter: `user_id=eq.${userId}`,
        },
        () => {
          void refresh();
        }
      )
      .subscribe();
    const poll = setInterval(() => {
      void refresh();
    }, 45000);
    return () => {
      clearInterval(poll);
      if (supabase) void supabase.removeChannel(channel);
    };
  }, [refresh, userId]);

  const onItemPress = useCallback(
    async (n: AppNotification) => {
      if (supabase && userId && !n.read_at) {
        await markNotificationsRead(supabase, userId, [n.id]);
        await refresh();
      }
      setOpen(false);
      const route = resolveNotificationRoute(n.type, n.data);
      if (!route) return;
      const href = hrefForNotificationRoute(role, route);
      try {
        router.push(href as never);
      } catch (err) {
        console.warn('notification navigate', err);
      }
    },
    [refresh, role, router, userId]
  );

  if (!userId) return null;

  return (
    <>
      <Pressable
        onPress={() => {
          setOpen(true);
          void refresh();
        }}
        hitSlop={8}
        accessibilityLabel={t('notifications.title')}
        style={styles.bellBtn}
      >
        <Ionicons name="notifications" size={22} color="#1e3a5f" />
        {unread > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{unread > 99 ? '99+' : String(unread)}</Text>
          </View>
        ) : null}
      </Pressable>

      <Modal visible={open} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setOpen(false)}>
        <View style={styles.modal}>
          <View style={styles.modalHead}>
            <Text style={styles.modalTitle}>{t('notifications.title')}</Text>
            <View style={styles.modalHeadActions}>
              <Pressable
                onPress={() => {
                  if (!supabase || !userId) return;
                  void markAllNotificationsRead(supabase, userId).then(() => refresh());
                }}
                hitSlop={8}
              >
                <Text style={styles.markAll}>{t('notifications.markAllRead')}</Text>
              </Pressable>
              <Pressable onPress={() => setOpen(false)} hitSlop={8}>
                <Text style={styles.close}>{t('common.close')}</Text>
              </Pressable>
            </View>
          </View>
          {loading && !items.length ? (
            <ActivityIndicator color="#c41230" style={{ marginTop: 24 }} />
          ) : !items.length ? (
            <Text style={styles.empty}>{t('notifications.empty')}</Text>
          ) : (
            <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
              {items.map((n) => (
                <Pressable
                  key={n.id}
                  style={[styles.item, !n.read_at && styles.itemUnread]}
                  onPress={() => {
                    void onItemPress(n);
                  }}
                  accessibilityHint={t('notifications.openHint')}
                >
                  <Text style={styles.itemTitle}>{n.title}</Text>
                  {n.body ? <Text style={styles.itemBody}>{n.body}</Text> : null}
                  <Text style={styles.itemMeta}>{formatWhen(n.created_at, locale)}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  bellBtn: {
    marginRight: 4,
    padding: 4,
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#c41230',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  badgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
  },
  modal: {
    flex: 1,
    backgroundColor: '#fff',
    paddingTop: 16,
    paddingHorizontal: 16,
  },
  modalHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
    gap: 8,
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0f172a',
  },
  modalHeadActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  markAll: {
    color: '#c41230',
    fontWeight: '600',
  },
  close: {
    color: '#475569',
    fontWeight: '600',
  },
  empty: {
    marginTop: 24,
    color: '#64748b',
    fontSize: 15,
  },
  item: {
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#e2e8f0',
  },
  itemUnread: {
    backgroundColor: '#fff7f8',
    marginHorizontal: -8,
    paddingHorizontal: 8,
    borderRadius: 8,
  },
  itemTitle: {
    fontWeight: '700',
    color: '#0f172a',
    fontSize: 15,
  },
  itemBody: {
    marginTop: 4,
    color: '#475569',
    fontSize: 14,
  },
  itemMeta: {
    marginTop: 6,
    color: '#94a3b8',
    fontSize: 12,
  },
});
