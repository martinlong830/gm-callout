import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';

export default function Index() {
  const { session, role, loading } = useAuth();

  if (loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!isSupabaseConfigured) {
    return <Redirect href="/login" />;
  }
  if (!session) {
    return <Redirect href="/login" />;
  }
  if (role === 'manager') {
    return <Redirect href="/manager" />;
  }
  if (role === 'employee') {
    return <Redirect href="/employee" />;
  }
  return <Redirect href="/login" />;
}
