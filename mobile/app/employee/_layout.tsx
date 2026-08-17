import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, type ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { LanguageToggle } from '../../components/LanguageToggle';
import { NotificationBellButton } from '../../components/NotificationBellButton';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';

function HeaderActions({ onSignOut }: { onSignOut: () => void }) {
  const router = useRouter();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: portrait ? 6 : 10,
        marginRight: portrait ? 4 : 12,
        maxWidth: portrait ? Math.min(168, width * 0.48) : undefined,
        flexShrink: 1,
      }}
    >
      <NotificationBellButton />
      <LanguageToggle variant="compact" />
      {!portrait ? (
        <>
          <Pressable onPress={() => router.push('/account')} hitSlop={8}>
            <Text style={{ color: '#c41230', fontWeight: '600' }}>{t('common.account')}</Text>
          </Pressable>
          <Pressable onPress={onSignOut} hitSlop={8}>
            <Text style={{ color: '#c41230', fontWeight: '600' }}>{t('common.signOut')}</Text>
          </Pressable>
        </>
      ) : (
        <Pressable
          onPress={() => router.push('/account')}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.account')}
        >
          <Ionicons name="person-circle-outline" size={24} color="#c41230" />
        </Pressable>
      )}
    </View>
  );
}

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function EmployeeLayout() {
  const { session, role, signOut } = useAuth();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  const renderHeaderRight = useCallback(
    () => <HeaderActions onSignOut={() => void signOut()} />,
    [signOut]
  );

  useEffect(() => {
    if (!session || role !== 'employee') return;
    let cancelled = false;
    void import('../../lib/pushNotifications')
      .then((m) => {
        if (cancelled) return;
        m.setPushNotificationRouteRoleGetter(() => role);
        m.startPushNotificationResponseRouting();
      })
      .catch((err) => console.warn('pushNotifications routing', err));
    return () => {
      cancelled = true;
      void import('../../lib/pushNotifications')
        .then((m) => m.setPushNotificationRouteRoleGetter(null))
        .catch(() => undefined);
    };
  }, [session, role]);

  if (!session || role !== 'employee') {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        freezeOnBlur: true,
        lazy: true,
        headerRight: renderHeaderRight,
        headerRightContainerStyle: {
          paddingRight: portrait ? 4 : 8,
          flexShrink: 1,
          maxWidth: portrait ? '52%' : undefined,
        },
        headerTitleContainerStyle: {
          flexShrink: 1,
          maxWidth: portrait ? '46%' : undefined,
        },
        headerTitleStyle: {
          fontSize: portrait ? 16 : 17,
        },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: t('nav.home'),
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: t('nav.schedule'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="calendar-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="availability"
        options={{
          title: t('nav.availability'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="actions"
        options={{
          title: t('nav.actions'),
          tabBarIcon: ({ color, size }) => <Ionicons name="list-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: t('nav.messages'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
