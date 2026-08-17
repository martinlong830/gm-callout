import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { RootErrorBoundary } from '../components/RootErrorBoundary';
import { AuthProvider } from '../contexts/AuthContext';
import { AppDataProvider } from '../contexts/AppDataContext';
import { LocaleProvider } from '../contexts/LocaleContext';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* Locale outside the root boundary so fallback UI can still translate. */}
      <LocaleProvider>
        <RootErrorBoundary>
          <AuthProvider>
            <AppDataProvider>
              <Stack screenOptions={{ headerShown: false }} />
            </AppDataProvider>
          </AuthProvider>
        </RootErrorBoundary>
      </LocaleProvider>
    </GestureHandlerRootView>
  );
}
