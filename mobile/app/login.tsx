import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../contexts/AuthContext';
import { isSupabaseConfigured } from '../lib/supabase';

export default function LoginScreen() {
  const router = useRouter();
  const { signIn, session, role, loading: authLoading } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (session && role === 'manager') router.replace('/manager');
    else if (session && role === 'employee') router.replace('/employee');
  }, [authLoading, session, role, router]);

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <StatusBar style="dark" />
      </View>
    );
  }

  async function onSubmit() {
    setMessage(null);
    const e = email.trim();
    if (!e || !password) {
      setMessage('Enter email and password.');
      return;
    }
    setBusy(true);
    const res = await signIn(e, password);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    router.replace('/');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.scroll}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title}>Red Poke Scheduler</Text>
          <Text style={styles.subtitle}>Sign in with the same email and password as the web app.</Text>

          {!isSupabaseConfigured ? (
            <View style={styles.card}>
              <Text style={styles.warn}>
                Missing Supabase env. Add EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY to
                mobile/.env and restart Expo.
              </Text>
            </View>
          ) : (
            <View style={styles.card}>
              <Text style={styles.label}>Email</Text>
              <TextInput
                style={styles.input}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                value={email}
                onChangeText={setEmail}
                placeholder="you@example.com"
                placeholderTextColor="#888"
              />
              <Text style={styles.label}>Password</Text>
              <TextInput
                style={styles.input}
                secureTextEntry
                autoComplete="password"
                value={password}
                onChangeText={setPassword}
                placeholder="••••••••"
                placeholderTextColor="#888"
              />
              {message ? <Text style={styles.error}>{message}</Text> : null}
              <Pressable
                style={[styles.button, styles.buttonPrimary]}
                onPress={onSubmit}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Sign in</Text>
                )}
              </Pressable>
            </View>
          )}
        </ScrollView>
        <StatusBar style="dark" />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f4f6f8' },
  flex: { flex: 1 },
  scroll: { padding: 20, paddingBottom: 40 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 15, color: '#555', marginBottom: 24, lineHeight: 22 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  label: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6 },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 16,
    marginBottom: 14,
    backgroundColor: '#fafbfc',
  },
  button: { borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 4 },
  buttonPrimary: { backgroundColor: '#c41230' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#b00020', marginBottom: 8, fontSize: 14 },
  warn: { fontSize: 14, color: '#444', lineHeight: 22 },
});
