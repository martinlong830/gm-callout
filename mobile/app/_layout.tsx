import 'react-native-gesture-handler';
import { Stack } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AuthProvider } from '../contexts/AuthContext';
import { AppDataProvider } from '../contexts/AppDataContext';

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <AuthProvider>
        <AppDataProvider>
          <Stack screenOptions={{ headerShown: false }} />
        </AppDataProvider>
      </AuthProvider>
    </GestureHandlerRootView>
  );
}
