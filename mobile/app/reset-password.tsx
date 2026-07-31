import * as Linking from 'expo-linking';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useState } from 'react';
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
import { useI18n } from '../contexts/LocaleContext';

/** Near-black so secureTextEntry bullets stay visible on light fields (Android OEM themes). */
const INPUT_TEXT = '#020617';
const INPUT_PLACEHOLDER = '#94a3b8';
const PRIMARY = '#1e3a5f';

function PasswordInput({
  style,
  autoComplete = 'new-password',
  textContentType = 'newPassword',
  placeholder = 'Password',
  placeholderTextColor = INPUT_PLACEHOLDER,
  ...rest
}: React.ComponentProps<typeof TextInput>) {
  return (
    <TextInput
      {...rest}
      style={[styles.input, style, styles.passwordInput]}
      secureTextEntry
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      keyboardType="default"
      textContentType={textContentType}
      autoComplete={autoComplete}
      placeholder={placeholder}
      placeholderTextColor={placeholderTextColor}
      selectionColor={PRIMARY}
      cursorColor={INPUT_TEXT}
      importantForAutofill="yes"
    />
  );
}

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
  const { t: tr } = useI18n();
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
          setMessage(tr('auth.missingResetLink'));
        }
        return;
      }
      if (!cancelled) setToken(t);
      if (!isPortalAuthConfigured()) {
        if (!cancelled) {
          setVerifying(false);
          setMessage(tr('auth.portalNotConfigured'));
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
      setMessage(tr('auth.resetLinkInvalid'));
      return;
    }
    if (password.length < 4) {
      setMessage(tr('auth.passwordMinLength'));
      return;
    }
    if (password !== confirm) {
      setMessage(tr('auth.passwordsMismatch'));
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
    setMessage(res.message || tr('auth.passwordUpdated'));
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>{tr('auth.forgotTitle')}</Text>
          {loginName ? (
            <Text style={styles.subtitle}>{tr('auth.setPasswordFor', { name: loginName })}</Text>
          ) : (
            <Text style={styles.subtitle}>{tr('auth.setPasswordAccount')}</Text>
          )}

          {verifying ? (
            <ActivityIndicator style={{ marginTop: 24 }} />
          ) : (
            <View style={styles.card}>
              {!success ? (
                <>
                  <Text style={styles.label}>{tr('auth.newPassword')}</Text>
                  <PasswordInput
                    value={password}
                    onChangeText={setPassword}
                    placeholder={tr('auth.newPassword')}
                  />
                  <Text style={styles.label}>{tr('auth.confirmPassword')}</Text>
                  <PasswordInput
                    value={confirm}
                    onChangeText={setConfirm}
                    placeholder={tr('auth.confirmPassword')}
                  />
                  {message ? (
                    <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                  ) : null}
                  <Pressable style={styles.buttonPrimary} onPress={() => void onSubmit()} disabled={busy}>
                    {busy ? (
                      <ActivityIndicator color="#fff" />
                    ) : (
                      <Text style={styles.buttonText}>{tr('auth.updatePassword')}</Text>
                    )}
                  </Pressable>
                </>
              ) : (
                <>
                  {message ? <Text style={[styles.feedback, styles.feedbackOk]}>{message}</Text> : null}
                  <Pressable style={styles.buttonPrimary} onPress={() => router.replace('/login')}>
                    <Text style={styles.buttonText}>{tr('auth.backToSignIn')}</Text>
                  </Pressable>
                </>
              )}
              <Pressable style={styles.linkBtn} onPress={() => router.replace('/login')}>
                <Text style={styles.linkText}>{tr('common.cancel')}</Text>
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
    color: INPUT_TEXT,
    marginBottom: 14,
    backgroundColor: '#ffffff',
    ...(Platform.OS === 'android'
      ? {
          minHeight: 48,
          includeFontPadding: false,
          textAlignVertical: 'center' as const,
        }
      : null),
  },
  passwordInput: {
    color: INPUT_TEXT,
    fontSize: 17,
    letterSpacing: 1.2,
    backgroundColor: '#ffffff',
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
