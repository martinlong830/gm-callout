import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';
import { LanguageToggle } from '../../components/LanguageToggle';
import { NotificationBellButton } from '../../components/NotificationBellButton';
import { useAuth } from '../../contexts/AuthContext';
import { useI18n } from '../../contexts/LocaleContext';

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

export default function EmployeeLayout() {
  const { session, role, signOut } = useAuth();
  const { t } = useI18n();
  if (!session || role !== 'employee') {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        freezeOnBlur: true,
        lazy: true,
        headerRight: () => <HeaderActions onSignOut={() => void signOut()} />,
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
