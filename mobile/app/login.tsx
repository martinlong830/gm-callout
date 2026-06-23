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
import {
  isPortalAuthConfigured,
  portalRequestPasswordReset,
  portalWebUrl,
} from '../lib/portalAuth';
import { isSupabaseConfigured } from '../lib/supabase';

type Panel = 'signin' | 'forgot' | 'employee-reg' | 'manager-reg';

const STAFF_TYPES = [
  { value: 'Kitchen' as const, label: 'Back of the House' },
  { value: 'Bartender' as const, label: 'Front of the House' },
  { value: 'Server' as const, label: 'Delivery/Dishwasher' },
];

export default function LoginScreen() {
  const router = useRouter();
  const { signIn, signUp, session, role, loading: authLoading } = useAuth();
  const [panel, setPanel] = useState<Panel>('signin');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [recoveryEmail, setRecoveryEmail] = useState('');
  const [staffType, setStaffType] = useState<'Kitchen' | 'Bartender' | 'Server'>('Kitchen');
  const [regPassword, setRegPassword] = useState('');
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('');

  const [accessCode, setAccessCode] = useState('');
  const [mgrName, setMgrName] = useState('');
  const [mgrRecoveryEmail, setMgrRecoveryEmail] = useState('');
  const [mgrPassword, setMgrPassword] = useState('');
  const [mgrPasswordConfirm, setMgrPasswordConfirm] = useState('');

  useEffect(() => {
    if (authLoading) return;
    if (session && role === 'manager') router.replace('/manager');
    else if (session && role === 'employee') router.replace('/employee');
  }, [authLoading, session, role, router]);

  function clearMsg() {
    setMessage(null);
    setSuccess(false);
  }

  function goSignIn(prefillName?: string) {
    clearMsg();
    setPanel('signin');
    if (prefillName) setLoginName(prefillName);
  }

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" />
        <StatusBar style="dark" />
      </View>
    );
  }

  async function onSignIn() {
    clearMsg();
    const name = loginName.trim();
    if (!name || !password) {
      setMessage('Enter your name and password.');
      return;
    }
    setBusy(true);
    const res = await signIn(name, password);
    setBusy(false);
    if (!res.ok) {
      const hint =
        res.message.includes('timed out') || res.message.includes('Could not reach')
          ? `\n\nTrying: ${portalWebUrl()}`
          : '';
      setMessage(res.message + hint);
      return;
    }
    router.replace(res.role === 'manager' ? '/manager' : '/employee');
  }

  async function onForgot() {
    clearMsg();
    const name = loginName.trim();
    if (!name) {
      setMessage('Enter your sign-in name.');
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage('Set EXPO_PUBLIC_GM_WEB_URL to your web server, then restart Expo.');
      return;
    }
    setBusy(true);
    const res = await portalRequestPasswordReset(name);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    setSuccess(true);
    setMessage(
      res.message ||
        'If that name is on file, we sent a password reset link. Check your inbox and spam folder.'
    );
  }

  async function onEmployeeRegister() {
    clearMsg();
    const fn = firstName.trim();
    const ln = lastName.trim();
    const displayName = `${fn} ${ln}`.trim();
    if (!displayName) {
      setMessage('First and last name are required.');
      return;
    }
    if (!phone.trim()) {
      setMessage('Phone number is required.');
      return;
    }
    if (!recoveryEmail.trim()) {
      setMessage('Recovery email is required.');
      return;
    }
    if (regPassword.length < 4) {
      setMessage('Password must be at least 4 characters.');
      return;
    }
    if (regPassword !== regPasswordConfirm) {
      setMessage('Passwords do not match.');
      return;
    }
    setBusy(true);
    const res = await signUp(
      {
        loginName: displayName,
        password: regPassword,
        role: 'employee',
        displayName,
        phone: phone.trim(),
        staffType,
        recoveryEmail: recoveryEmail.trim(),
      },
      { firstName: fn, lastName: ln, phone: phone.trim(), staffType }
    );
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    if (res.needsSignIn) {
      setSuccess(true);
      setMessage(res.message || 'Account created. Sign in with your name and password.');
      goSignIn(displayName);
      return;
    }
    router.replace('/');
  }

  async function onManagerRegister() {
    clearMsg();
    const name = mgrName.trim();
    if (!name) {
      setMessage('Name is required.');
      return;
    }
    if (!mgrRecoveryEmail.trim()) {
      setMessage('Recovery email is required.');
      return;
    }
    if (mgrPassword.length < 4) {
      setMessage('Password must be at least 4 characters.');
      return;
    }
    if (mgrPassword !== mgrPasswordConfirm) {
      setMessage('Passwords do not match.');
      return;
    }
    setBusy(true);
    const res = await signUp({
      loginName: name,
      password: mgrPassword,
      role: 'manager',
      accessCode: accessCode.trim(),
      displayName: name,
      recoveryEmail: mgrRecoveryEmail.trim(),
    });
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    if (res.needsSignIn) {
      setSuccess(true);
      setMessage(res.message || 'Account created. Sign in with your name and password.');
      goSignIn(name);
      return;
    }
    router.replace('/');
  }

  const portalOk = isPortalAuthConfigured();
  const supabaseOk = isSupabaseConfigured;

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          <Text style={styles.title}>Shiflow</Text>

          {!supabaseOk ? (
            <View style={styles.card}>
              <Text style={styles.warn}>
                Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in
                mobile/.env (or EAS secrets for production builds).
              </Text>
            </View>
          ) : !portalOk ? (
            <View style={styles.card}>
              <Text style={styles.warn}>
                Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env (HTTPS production or LAN IP), then restart Expo with -c.
              </Text>
            </View>
          ) : (
            <Text style={styles.urlHint}>Sign-in server: {portalWebUrl()}</Text>
          )}

          {panel === 'signin' ? (
            <>
              <Text style={styles.subtitle}>Sign in with the same name and password as the web app.</Text>
              <View style={styles.card}>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="words"
                  autoComplete="username"
                  value={loginName}
                  onChangeText={setLoginName}
                  placeholder="Your full name"
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
                {message ? (
                  <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                ) : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onSignIn()}
                  disabled={busy || !supabaseOk}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Sign in</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('forgot');
                  }}
                >
                  <Text style={styles.linkText}>Forgot password?</Text>
                </Pressable>
              </View>
              <View style={styles.footer}>
                <Pressable
                  onPress={() => {
                    clearMsg();
                    setPanel('employee-reg');
                  }}
                >
                  <Text style={styles.linkText}>Create employee account</Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    clearMsg();
                    setPanel('manager-reg');
                  }}
                >
                  <Text style={styles.linkText}>Create manager account</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {panel === 'forgot' ? (
            <>
              <Text style={styles.subtitle}>Reset password</Text>
              <Text style={styles.hint}>
                Enter your sign-in name. We email a reset link to the recovery email on that account. Add or change
                it after sign-in under Account.
              </Text>
              <View style={styles.card}>
                <Text style={styles.label}>Name</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="words"
                  value={loginName}
                  onChangeText={setLoginName}
                  placeholder="Your sign-in name"
                  placeholderTextColor="#888"
                />
                {message ? (
                  <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                ) : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onForgot()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Send reset link</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>Back to sign in</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {panel === 'employee-reg' ? (
            <>
              <Text style={styles.subtitle}>Create employee account</Text>
              <View style={styles.card}>
                <Text style={styles.label}>First name</Text>
                <TextInput style={styles.input} value={firstName} onChangeText={setFirstName} autoCapitalize="words" />
                <Text style={styles.label}>Last name</Text>
                <TextInput style={styles.input} value={lastName} onChangeText={setLastName} autoCapitalize="words" />
                <Text style={styles.label}>Phone number</Text>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                />
                <Text style={styles.label}>Recovery email</Text>
                <TextInput
                  style={styles.input}
                  value={recoveryEmail}
                  onChangeText={setRecoveryEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
                <Text style={styles.hintTight}>Used to reset your password if you forget it.</Text>
                <Text style={styles.label}>Staff type</Text>
                <View style={styles.chipRow}>
                  {STAFF_TYPES.map((st) => {
                    const on = staffType === st.value;
                    return (
                      <Pressable
                        key={st.value}
                        style={[styles.chip, on && styles.chipOn]}
                        onPress={() => setStaffType(st.value)}
                      >
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{st.label}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.label}>Password</Text>
                <TextInput style={styles.input} secureTextEntry value={regPassword} onChangeText={setRegPassword} />
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={regPasswordConfirm}
                  onChangeText={setRegPasswordConfirm}
                />
                {message ? <Text style={styles.feedback}>{message}</Text> : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onEmployeeRegister()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Create account</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>Back to sign in</Text>
                </Pressable>
              </View>
            </>
          ) : null}

          {panel === 'manager-reg' ? (
            <>
              <Text style={styles.subtitle}>Create manager account</Text>
              <Text style={styles.hint}>Enter the access code, your name, recovery email, and password.</Text>
              <View style={styles.card}>
                <Text style={styles.label}>Access code</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={accessCode}
                  onChangeText={setAccessCode}
                  autoCapitalize="none"
                />
                <Text style={styles.label}>Name</Text>
                <TextInput style={styles.input} value={mgrName} onChangeText={setMgrName} autoCapitalize="words" />
                <Text style={styles.label}>Recovery email</Text>
                <TextInput
                  style={styles.input}
                  value={mgrRecoveryEmail}
                  onChangeText={setMgrRecoveryEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
                <Text style={styles.hintTight}>Used to reset your password if you forget it.</Text>
                <Text style={styles.label}>Password</Text>
                <TextInput style={styles.input} secureTextEntry value={mgrPassword} onChangeText={setMgrPassword} />
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={mgrPasswordConfirm}
                  onChangeText={setMgrPasswordConfirm}
                />
                {message ? <Text style={styles.feedback}>{message}</Text> : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onManagerRegister()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Create manager account</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>Back to sign in</Text>
                </Pressable>
              </View>
            </>
          ) : null}
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
  subtitle: { fontSize: 15, color: '#555', marginBottom: 16, lineHeight: 22 },
  hint: { fontSize: 14, color: '#64748b', marginBottom: 16, lineHeight: 20 },
  hintTight: { fontSize: 12, color: '#64748b', marginBottom: 10, marginTop: -6 },
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
  feedback: { color: '#b00020', marginBottom: 8, fontSize: 14, lineHeight: 20 },
  feedbackOk: { color: '#166534' },
  linkBtn: { marginTop: 14, alignItems: 'center' },
  linkText: { color: '#c41230', fontWeight: '600', fontSize: 15 },
  footer: { marginTop: 20, gap: 12, alignItems: 'center' },
  warn: { fontSize: 14, color: '#444', lineHeight: 22 },
  urlHint: { fontSize: 12, color: '#64748b', marginBottom: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  chipOn: { backgroundColor: '#c41230', borderColor: '#c41230' },
  chipText: { fontSize: 12, color: '#334155', fontWeight: '600' },
  chipTextOn: { color: '#fff' },
});
