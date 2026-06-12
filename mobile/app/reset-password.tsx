import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
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
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  isPortalAuthConfigured,
  portalResetPassword,
  portalVerifyResetToken,
} from '../lib/portalAuth';

function tokenFromUrl(url: string | null): string {
  if (!url) return '';
  try {
    const parsed = Linking.parse(url);
    const q = parsed.queryParams?.reset_token;
    if (typeof q === 'string') return q.trim();
    if (Array.isArray(q) && q[0]) return String(q[0]).trim();
    const m = url.match(/[?&]reset_token=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch {
    return '';
  }
}

export default function ResetPasswordScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ token?: string }>();
  const [token, setToken] = useState('');
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [verifying, setVerifying] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const fromParam = typeof params.token === 'string' ? params.token.trim() : '';
      let t = fromParam;
      if (!t) {
        const initial = await Linking.getInitialURL();
        t = tokenFromUrl(initial);
      }
      if (!t) {
        if (!cancelled) {
          setVerifying(false);
          setMessage('Missing reset link. Open the link from your email or request a new reset from sign in.');
        }
        return;
      }
      if (!cancelled) setToken(t);
      if (!isPortalAuthConfigured()) {
        if (!cancelled) {
          setVerifying(false);
          setMessage('Set EXPO_PUBLIC_GM_WEB_URL to your web server, then restart the app.');
        }
        return;
      }
      const verified = await portalVerifyResetToken(t);
      if (cancelled) return;
      setVerifying(false);
      if (!verified.ok) {
        setMessage(verified.message);
        return;
      }
      setLoginName(verified.loginName);
    })();
    const sub = Linking.addEventListener('url', (ev) => {
      const t = tokenFromUrl(ev.url);
      if (t) {
        setToken(t);
        void portalVerifyResetToken(t).then((r) => {
          if (r.ok) {
            setLoginName(r.loginName);
            setMessage(null);
          } else setMessage(r.message);
        });
      }
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [params.token]);

  async function onSubmit() {
    setMessage(null);
    if (!token) {
      setMessage('Reset link is missing or invalid.');
      return;
    }
    if (password.length < 4) {
      setMessage('Password must be at least 4 characters.');
      return;
    }
    if (password !== confirm) {
      setMessage('Passwords do not match.');
      return;
    }
    setBusy(true);
    const res = await portalResetPassword(token, password);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    setSuccess(true);
    setMessage(res.message || 'Password updated. Sign in with your new password.');
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Reset password</Text>
          {loginName ? (
            <Text style={styles.subtitle}>Set a new password for {loginName}.</Text>
          ) : (
            <Text style={styles.subtitle}>Set a new password for your account.</Text>
          )}

          {verifying ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <View style={styles.card}>
              {!success ? (
                <>
                  <Text style={styles.label}>New password</Text>
                  <TextInput
                    style={styles.input}
                    secureTextEntry
                    value={password}
                    onChangeText={setPassword}
                    autoComplete="new-password"
                  />
                  <Text style={styles.label}>Confirm password</Text>
                  <TextInput
                    style={styles.input}
                    secureTextEntry
                    value={confirm}
                    onChangeText={setConfirm}
                    autoComplete="new-password"
                  />
                  {message ? (
                    <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                  ) : null}
                  <Pressable style={styles.buttonPrimary} onPress={() => void onSubmit()} disabled={busy}>
                    {busy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>Update password</Text>
                    )}
                  </Pressable>
                </>
              ) : (
                <>
                  {message ? <Text style={[styles.feedback, styles.feedbackOk]}>{message}</Text> : null}
                  <Pressable style={styles.buttonPrimary} onPress={() => router.replace('/login')}>
                    <Text style={styles.buttonText}>Back to sign in</Text>
                  </Pressable>
                </>
              )}
              <Pressable style={styles.linkBtn} onPress={() => router.replace('/login')}>
                <Text style={styles.linkText}>Cancel</Text>
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
  title: { fontSize: 22, fontWeight: '700', color: '#111', marginBottom: 8 },
  subtitle: { fontSize: 15, color: '#555', marginBottom: 20, lineHeight: 22 },
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
  buttonPrimary: {
    backgroundColor: '#c41230',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  feedback: { color: '#b00020', marginBottom: 12, fontSize: 14, lineHeight: 20 },
  feedbackOk: { color: '#166534' },
  linkBtn: { marginTop: 16, alignItems: 'center' },
  linkText: { color: '#c41230', fontWeight: '600', fontSize: 15 },
});
