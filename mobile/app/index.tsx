import { Redirect } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';
import { RouteErrorFallback } from '../components/RouteErrorFallback';
import { useAuth } from '../contexts/AuthContext';
import { isAdminRole, isManagerLikeRole } from '../lib/roles';
import { isSupabaseConfigured } from '../lib/supabase';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

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
  if (isAdminRole(role)) {
    return <Redirect href="/manager/schedule" />;
  }
  if (isManagerLikeRole(role)) {
    return <Redirect href="/manager" />;
  }
  if (role === 'employee') {
    return <Redirect href="/employee" />;
  }
  return <Redirect href="/login" />;
}
