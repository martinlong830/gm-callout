import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { LanguageToggle } from '../../components/LanguageToggle';
import { NotificationBellButton } from '../../components/NotificationBellButton';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';
import { isAdminRole, isManagerLikeRole } from '../../lib/roles';

function HeaderActions({ onSignOut }: { onSignOut: () => void }) {
  const router = useRouter();
  const { t } = useI18n();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginRight: 12 }}>
      <NotificationBellButton />
      <LanguageToggle variant="compact" />
      <Pressable onPress={() => router.push('/account')} hitSlop={8}>
        <Text style={{ color: '#c41230', fontWeight: '600' }}>{t('common.account')}</Text>
      </Pressable>
      <Pressable onPress={onSignOut} hitSlop={8}>
        <Text style={{ color: '#c41230', fontWeight: '600' }}>{t('common.signOut')}</Text>
      </Pressable>
    </View>
  );
}

export default function ManagerLayout() {
  const { session, role, signOut } = useAuth();
  const { t } = useI18n();

  useEffect(() => {
    if (!session || !isManagerLikeRole(role)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void import('../../lib/pushNotifications')
        .then((m) => {
          if (cancelled) return;
          m.setPushNotificationRouteRoleGetter(() => role);
          m.startPushNotificationResponseRouting();
          m.scheduleDevicePushTokenRegistration(0);
        })
        .catch((err) => console.warn('pushNotifications dynamic import', err));
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      void import('../../lib/pushNotifications')
        .then((m) => m.setPushNotificationRouteRoleGetter(null))
        .catch(() => undefined);
    };
  }, [session, role]);

  if (!session || !isManagerLikeRole(role)) {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      initialRouteName="schedule"
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        headerRight: () => <HeaderActions onSignOut={() => void signOut()} />,
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
