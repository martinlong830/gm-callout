import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { Pressable, Text } from 'react-native';
import { useAuth } from '../../contexts/AuthContext';

export default function ManagerLayout() {
  const { session, role, signOut } = useAuth();
  if (!session || role !== 'manager') {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      initialRouteName="schedule"
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        headerRight: () => (
          <Pressable onPress={() => void signOut()} style={{ marginRight: 16 }} hitSlop={8}>
            <Text style={{ color: '#c41230', fontWeight: '600' }}>Sign Out</Text>
          </Pressable>
        ),
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
    </Tabs>
  );
}
