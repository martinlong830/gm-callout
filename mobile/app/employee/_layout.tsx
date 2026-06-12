import { Ionicons } from '@expo/vector-icons';
import { Redirect, Tabs } from 'expo-router';
import { useRouter } from 'expo-router';
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

export default function EmployeeLayout() {
  const { session, role, signOut } = useAuth();
  if (!session || role !== 'employee') {
    return <Redirect href="/login" />;
  }

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: '#c41230',
        headerRight: () => <HeaderActions onSignOut={() => void signOut()} />,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Home',
          tabBarIcon: ({ color, size }) => <Ionicons name="home-outline" size={size} color={color} />,
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
        name="actions"
        options={{
          title: 'Actions',
          tabBarIcon: ({ color, size }) => <Ionicons name="list-outline" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
