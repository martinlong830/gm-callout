import { Redirect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useAuth } from '../contexts/AuthContext';
import { storeCompanySession } from '../lib/companySession';
import {
  portalGetAccount,
  portalUpdateCompany,
  portalUpdateRecoveryEmail,
} from '../lib/portalAuth';

export default function AccountScreen() {
  const router = useRouter();
  const { session, role, loading: authLoading } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [hasRecovery, setHasRecovery] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    const acct = await portalGetAccount();
    setLoading(false);
    if (!acct.ok) {
      setMessage(acct.message);
      return;
    }
    setLoginName(acct.loginName);
    setRecoveryEmail(acct.recoveryEmail);
    setHasRecovery(acct.hasRecoveryEmail);
    setCompanyName(acct.companyName || '');
    setIsManager(acct.role === 'manager' || role === 'manager');
  }, [role]);

  useEffect(() => {
    if (!session) return;
    void load();
  }, [session, load]);

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!session) {
    return <Redirect href="/login" />;
  }

  async function onSave() {
    setMessage(null);
    setBusy(true);
    if (isManager) {
      const name = companyName.trim();
      if (!name) {
        setBusy(false);
        setMessage('Company name is required.');
        return;
      }
      const co = await portalUpdateCompany({ name });
      if (!co.ok) {
        setBusy(false);
        setMessage(co.message);
        return;
      }
      await storeCompanySession({
        companyId: co.companyId,
        companyName: co.companyName,
        accessCode: co.accessCode,
      });
      setCompanyName(co.companyName || name);
    }
    const res = await portalUpdateRecoveryEmail(recoveryEmail);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    setRecoveryEmail(res.recoveryEmail);
    setHasRecovery(true);
    Alert.alert('Saved', res.message);
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <View style={styles.headerRow}>
            <Pressable onPress={() => router.back()} hitSlop={8}>
              <Text style={styles.back}>← Back</Text>
            </Pressable>
          </View>
          <Text style={styles.title}>Account</Text>
          <Text style={styles.subtitle}>
            Your sign-in name stays the same. Add a recovery email so you can reset your password from the app or
            web.
            {isManager ? ' Managers can also edit the company name.' : ''}
          </Text>

          {loading ? (
            <ActivityIndicator style={{ marginTop: 20 }} />
          ) : (
            <View style={styles.card}>
              <Text style={styles.label}>Sign-in name</Text>
              <Text style={styles.readonly}>{loginName || '—'}</Text>
              <Text style={styles.label}>Role</Text>
              <Text style={styles.readonly}>{role === 'manager' ? 'Manager' : 'Employee'}</Text>

              {isManager ? (
                <>
                  <Text style={styles.label}>Company name</Text>
                  <TextInput
                    style={styles.input}
                    value={companyName}
                    onChangeText={setCompanyName}
                    autoCapitalize="words"
                    maxLength={120}
                    placeholder="Company name"
                    placeholderTextColor="#888"
                  />
                </>
              ) : null}

              <Text style={styles.label}>Recovery email</Text>
              <TextInput
                style={styles.input}
                value={recoveryEmail}
                onChangeText={setRecoveryEmail}
                autoCapitalize="none"
                keyboardType="email-address"
                autoComplete="email"
                placeholder="you@example.com"
                placeholderTextColor="#888"
              />
              {!hasRecovery ? (
                <Text style={styles.hint}>Required for password reset if you forget your password.</Text>
              ) : null}
              {message ? <Text style={styles.error}>{message}</Text> : null}
              <Pressable style={styles.buttonPrimary} onPress={() => void onSave()} disabled={busy}>
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Save account settings</Text>
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
  headerRow: { marginBottom: 8 },
  back: { color: '#c41230', fontWeight: '600', fontSize: 16 },
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 15, color: '#555', marginBottom: 20, lineHeight: 22 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 18,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  label: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 6, marginTop: 8 },
  readonly: { fontSize: 16, color: '#0f172a', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 16,
    marginBottom: 8,
    backgroundColor: '#fafbfc',
  },
  hint: { fontSize: 13, color: '#64748b', marginBottom: 12, lineHeight: 18 },
  buttonPrimary: {
    backgroundColor: '#c41230',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#b00020', marginTop: 8, fontSize: 14 },
});
