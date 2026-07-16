import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { RootErrorBoundary } from '../components/RootErrorBoundary';
import { AuthProvider } from '../contexts/AuthContext';
import { AppDataProvider } from '../contexts/AppDataContext';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <RootErrorBoundary>
        <AuthProvider>
          <AppDataProvider>
            <Stack screenOptions={{ headerShown: false }} />
          </AppDataProvider>
        </AuthProvider>
      </RootErrorBoundary>
    </GestureHandlerRootView>
  );
}
