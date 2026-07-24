import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useRouter } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useAuth } from '../../contexts/AuthContext';

function HeaderActions({ onSignOut }: { onSignOut: () => void }) {
  const router = useRouter();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginRight: 16 }}>
      <Pressable onPress={() => router.push('/account')} hitSlop={8}>
        <Text style={{ color: '#c41230', fontWeight: '600' }}>Account</Text>
      </Pressable>
      <Pressable onPress={onSignOut} hitSlop={8}>
        <Text style={{ color: '#c41230', fontWeight: '600' }}>Sign Out</Text>
      </Pressable>
    </View>
  );
}

export default function ManagerLayout() {
  const { session, role, signOut } = useAuth();

  // Register push for managers too so Publish/Notify self-tests reach this device.
  // Dynamic import only — never statically load expo-notifications at cold start.
  useEffect(() => {
    if (!session || role !== 'manager') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void import('../../lib/pushNotifications')
        .then((m) => {
          if (!cancelled) m.scheduleDevicePushTokenRegistration(0);
        })
        .catch((err) => console.warn('pushNotifications dynamic import', err));
    }, 2500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [session, role]);

  if (!session || role !== 'manager') {
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
          href: null,
        }}
      />
      <Tabs.Screen
        name="schedule"
        options={{
          title: 'Schedule',
          tabBarIcon: ({ color, size }) => <Ionicons name="calendar-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="team"
        options={{
          title: 'Team',
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="availability"
        options={{
          title: 'Availability',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="grid-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="requests"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color, size }) => <Ionicons name="file-tray-full-outline" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="messages"
        options={{
          title: 'Messages',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
        }}
      />
      <Tabs.Screen
        name="timecards"
        options={{
          title: 'Timecards',
          headerShown: false,
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="time-outline" size={size} color={color} />
          ),
        }}
      />
    </Tabs>
  );
}
