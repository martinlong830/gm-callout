import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs, type ErrorBoundaryProps } from 'expo-router';
import { useRouter } from 'expo-router';
import { useCallback, useEffect } from 'react';
import { Pressable, Text, useWindowDimensions, View } from 'react-native';
import { LanguageToggle } from '../../components/LanguageToggle';
import { BrandLogoHeader } from '../../components/BrandLogoHeader';
import { NotificationBellButton } from '../../components/NotificationBellButton';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { isAdminRole, isManagerLikeRole } from '../../lib/roles';

function HeaderActions({ onSignOut }: { onSignOut: () => void }) {
  const router = useRouter();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  /*
   * Portrait nav chrome is narrow: Account/Sign out text pushes EN/ES + bell left
   * over the title and into the scene. Keep only bell + language upright; account
   * actions stay reachable from Account. Landscape keeps the full row.
   */
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

export default function ManagerLayout() {
  const { session, role, signOut } = useAuth();
  const { t } = useI18n();
  const { width, height } = useWindowDimensions();
  const portrait = height >= width;
  const renderHeaderLeft = useCallback(() => <BrandLogoHeader />, []);
  const renderHeaderRight = useCallback(
    () => <HeaderActions onSignOut={() => void signOut()} />,
    [signOut]
  );

  useEffect(() => {
    if (!session || !isManagerLikeRole(role)) return;
    let cancelled = false;
    void import('../../lib/pushNotifications')
      .then((m) => {
        if (cancelled) return;
        m.setPushNotificationRouteRoleGetter(() => role);
        m.startPushNotificationResponseRouting();
        m.scheduleDevicePushTokenRegistration(0);
      })
      .catch((err) => console.warn('pushNotifications dynamic import', err));
    return () => {
      cancelled = true;
      void import('../../lib/pushNotifications')
        .then((m) => m.setPushNotificationRouteRoleGetter(null))
        .catch(() => undefined);
    };
  }, [session, role]);

  if (!session) {
    return <Redirect href="/login" />;
  }
  if (!isManagerLikeRole(role)) {
    return <Redirect href="/" />;
  }

  return (
    <Tabs
      initialRouteName="schedule"
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        lazy: true,
        freezeOnBlur: true,
        headerLeft: renderHeaderLeft,
        headerLeftContainerStyle: {
          paddingLeft: portrait ? 4 : 8,
        },
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
          href: isAdminRole(role) ? null : undefined,
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: t('nav.schedule'),
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: t('nav.team'),
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
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
        name="requests"
        options={{
          title: t('nav.actions'),
          tabBarIcon: ({ color, size }) => <Ionicons name="file-tray-full-outline" size={size} color={color} />,
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
      <Tabs.Screen
        name="timecards"
        options={{
          title: t('nav.timecards'),
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
