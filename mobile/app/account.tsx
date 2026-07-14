import { Redirect, useRouter } from 'expo-router';
import * as Linking from 'expo-linking';
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
  portalDeleteAccount,
  portalGetAccount,
  portalUpdateCompany,
  portalUpdateRecoveryEmail,
} from '../lib/portalAuth';

const SUPPORT_URL = 'https://shiflow.app/support.html';

export default function AccountScreen() {
  const router = useRouter();
  const { session, role, loading: authLoading, signOut } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [hasRecovery, setHasRecovery] = useState(false);
  const [isManager, setIsManager] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
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

  function onStartDelete() {
    setMessage(null);
    setDeleteConfirm('');
    setShowDeleteConfirm(true);
  }

  async function onConfirmDelete() {
    const typed = deleteConfirm.trim().toUpperCase();
    if (typed !== 'DELETE') {
      setMessage('Type DELETE (all caps) to permanently delete your account.');
      return;
    }
    setDeleting(true);
    setMessage(null);
    const res = await portalDeleteAccount('DELETE');
    if (!res.ok) {
      setDeleting(false);
      setMessage(res.message);
      return;
    }
    await signOut();
    setDeleting(false);
    Alert.alert('Account deleted', res.message, [
      { text: 'OK', onPress: () => router.replace('/login') },
    ]);
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
              <Pressable style={styles.buttonPrimary} onPress={() => void onSave()} disabled={busy || deleting}>
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={styles.buttonText}>Save account settings</Text>
                )}
              </Pressable>

              <View style={styles.supportBlock}>
                <Pressable
                  onPress={() => {
                    void Linking.openURL(SUPPORT_URL);
                  }}
                  hitSlop={8}
                  accessibilityRole="link"
                  accessibilityLabel="Contact support"
                >
                  <Text style={styles.supportLink}>Contact support</Text>
                </Pressable>
                <Text style={styles.supportHint}>Help with login, the app, or your account</Text>
              </View>

              <View style={styles.deleteBlock}>
                <Text style={styles.deleteTitle}>Delete account</Text>
                <Text style={styles.deleteHint}>
                  Permanently delete your Shiflow login and personal account data. This cannot be undone. Company
                  schedules and timecards for the restaurant are not erased.
                </Text>
                {!showDeleteConfirm ? (
                  <Pressable
                    style={styles.buttonDanger}
                    onPress={onStartDelete}
                    disabled={busy || deleting}
                  >
                    <Text style={styles.buttonText}>Delete account</Text>
                  </Pressable>
                ) : (
                  <>
                    <Text style={styles.label}>Type DELETE to confirm</Text>
                    <TextInput
                      style={styles.input}
                      value={deleteConfirm}
                      onChangeText={setDeleteConfirm}
                      autoCapitalize="characters"
                      autoCorrect={false}
                      placeholder="DELETE"
                      placeholderTextColor="#888"
                    />
                    <Pressable
                      style={styles.buttonDanger}
                      onPress={() => void onConfirmDelete()}
                      disabled={deleting}
                    >
                      {deleting ? (
                        <ActivityIndicator color="#fff" />
                      ) : (
                        <Text style={styles.buttonText}>Permanently delete account</Text>
                      )}
                    </Pressable>
                    <Pressable
                      style={styles.buttonGhost}
                      onPress={() => {
                        setShowDeleteConfirm(false);
                        setDeleteConfirm('');
                        setMessage(null);
                      }}
                      disabled={deleting}
                    >
                      <Text style={styles.buttonGhostText}>Cancel</Text>
                    </Pressable>
                  </>
                )}
              </View>
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
  back: { color: '#1e3a5f', fontWeight: '600', fontSize: 16 },
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
    backgroundColor: '#1e3a5f',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 12,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  error: { color: '#b00020', marginTop: 8, fontSize: 14 },
  supportBlock: {
    marginTop: 20,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: '#e2e6ea',
  },
  supportLink: { color: '#1e3a5f', fontSize: 16, fontWeight: '600' },
  supportHint: { color: '#64748b', fontSize: 13, marginTop: 4, lineHeight: 18 },
  deleteBlock: {
    marginTop: 24,
    paddingTop: 18,
    borderTopWidth: 1,
    borderTopColor: '#e2e6ea',
  },
  deleteTitle: { fontSize: 16, fontWeight: '700', color: '#b00020', marginBottom: 8 },
  deleteHint: { fontSize: 13, color: '#64748b', lineHeight: 18, marginBottom: 12 },
  buttonDanger: {
    backgroundColor: '#b00020',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonGhost: {
    paddingVertical: 12,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonGhostText: { color: '#64748b', fontSize: 15, fontWeight: '600' },
});
