import { useRouter, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
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
import * as Linking from 'expo-linking';
import { useAuth } from '../contexts/AuthContext';
import {
  clearCompanySession,
  isRedPokeAccessCode,
  readStoredCompanyId,
  RED_POKE_COMPANY_ID,
  storeCompanySession,
} from '../lib/companySession';
import {
  establishConfirmSessionForAccessCodeSetup,
  isPortalAuthConfigured,
  portalCreateCompany,
  portalRequestPasswordReset,
  portalSetupAccessCode,
  portalVerifyAccessCode,
  portalWebUrl,
} from '../lib/portalAuth';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type Panel =
  | 'landing'
  | 'access-code'
  | 'create-company'
  | 'pending'
  | 'setup-access-code'
  | 'signin'
  | 'forgot'
  | 'employee-reg'
  | 'manager-reg';

const STAFF_TYPES = [
  { value: 'Kitchen' as const, label: 'Back of the House' },
  { value: 'Bartender' as const, label: 'Front of the House' },
  { value: 'Server' as const, label: 'Delivery/Dishwasher' },
];

const PRIMARY = '#1e3a5f';

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ setup_access_code?: string }>();
  const { signIn, signUp, session, role, loading: authLoading } = useAuth();
  const [panel, setPanel] = useState<Panel>('landing');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingMessage, setPendingMessage] = useState('');
  const [setupAccessCodeValue, setSetupAccessCodeValue] = useState('');

  const [companyAccessCode, setCompanyAccessCode] = useState('');
  const [verifiedCompanyId, setVerifiedCompanyId] = useState('');
  const [verifiedAccessCode, setVerifiedAccessCode] = useState('');
  const [verifiedCompanyName, setVerifiedCompanyName] = useState('');

  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');

  const [createCompanyName, setCreateCompanyName] = useState('');
  const [createUsername, setCreateUsername] = useState('');
  const [createEmail, setCreateEmail] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createPasswordConfirm, setCreatePasswordConfirm] = useState('');

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
    if (params.setup_access_code === '1') {
      setPanel('setup-access-code');
    }
  }, [params.setup_access_code]);

  useEffect(() => {
    if (panel !== 'setup-access-code') return;
    let cancelled = false;
    (async () => {
      setBusy(true);
      clearMsg();
      let url: string | null = null;
      try {
        url = (await Linking.getInitialURL()) || null;
      } catch {
        url = null;
      }
      // Prefer the current deep-link query when Expo Router already parsed it.
      if (!url && params.setup_access_code === '1') {
        url = `https://shiflow.app/?setup_access_code=1`;
      }
      const established = await establishConfirmSessionForAccessCodeSetup(url);
      if (cancelled) return;
      setBusy(false);
      if (!established.ok) {
        setMessage(established.message);
        setSuccess(!!established.alreadySet);
        if (established.alreadySet) {
          try {
            if (supabase) await supabase.auth.signOut({ scope: 'local' });
          } catch {
            /* ignore */
          }
          setPanel('access-code');
        }
        return;
      }
      setMessage(null);
    })();
    const sub = Linking.addEventListener('url', (ev) => {
      void establishConfirmSessionForAccessCodeSetup(ev.url).then(async (established) => {
        if (cancelled) return;
        if (!established.ok) {
          setMessage(established.message);
          setSuccess(!!established.alreadySet);
          if (established.alreadySet) {
            try {
              if (supabase) await supabase.auth.signOut({ scope: 'local' });
            } catch {
              /* ignore */
            }
            setPanel('access-code');
          }
          return;
        }
        setPanel('setup-access-code');
        setMessage(null);
      });
    });
    return () => {
      cancelled = true;
      sub.remove();
    };
  }, [panel, params.setup_access_code]);

  useEffect(() => {
    if (authLoading) return;
    if (panel === 'setup-access-code') return;
    if (session && role === 'manager') router.replace('/manager');
    else if (session && role === 'employee') router.replace('/employee');
  }, [authLoading, session, role, router, panel]);

  function clearMsg() {
    setMessage(null);
    setSuccess(false);
  }

  function goLanding() {
    clearMsg();
    setPanel('landing');
  }

  function goSignIn(prefillName?: string) {
    clearMsg();
    setPanel('signin');
    if (prefillName) setLoginName(prefillName);
  }

  const showRedPokeBrand = panel === 'signin' && isRedPokeAccessCode(verifiedAccessCode);

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <StatusBar style="dark" />
      </View>
    );
  }

  async function onVerifyAccessCode() {
    clearMsg();
    const code = companyAccessCode.trim();
    if (!code) {
      setMessage('Enter your company access code.');
      return;
    }
    setBusy(true);
    // Always verify via API (including redpoke) so companyId is set for scoped sign-in.
    const res = await portalVerifyAccessCode(code);
    setBusy(false);
    if (!res.ok) {
      // Offline/dev fallback for the known Red Poke access code only.
      if (isRedPokeAccessCode(code)) {
        setVerifiedCompanyId(RED_POKE_COMPANY_ID);
        setVerifiedAccessCode('redpoke');
        setVerifiedCompanyName('Red Poke');
        await storeCompanySession({
          companyId: RED_POKE_COMPANY_ID,
          teamStateId: 'main',
          accessCode: 'redpoke',
          companyName: 'Red Poke',
        });
        goSignIn();
        return;
      }
      setMessage(res.message || 'Access code is incorrect.');
      return;
    }
    const companyId = res.companyId || (isRedPokeAccessCode(code) ? RED_POKE_COMPANY_ID : '');
    setVerifiedCompanyId(companyId);
    setVerifiedAccessCode(res.accessCode || code);
    setVerifiedCompanyName(res.companyName || '');
    await storeCompanySession({
      ...res,
      companyId,
    });
    goSignIn();
  }

  async function onCreateCompany() {
    clearMsg();
    const companyName = createCompanyName.trim();
    const username = createUsername.trim();
    const email = createEmail.trim();
    if (!companyName || !username || !email || !createPassword || !createPasswordConfirm) {
      setMessage('All fields are required.');
      return;
    }
    if (createPassword !== createPasswordConfirm) {
      setMessage('Passwords do not match.');
      return;
    }
    if (createPassword.length < 4) {
      setMessage('Password must be at least 4 characters.');
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage('Set EXPO_PUBLIC_GM_WEB_URL to your web server, then restart Expo.');
      return;
    }
    setBusy(true);
    const res = await portalCreateCompany({
      companyName,
      username,
      email,
      password: createPassword,
      passwordConfirm: createPasswordConfirm,
    });
    setBusy(false);
    if (!res.ok) {
      let errMsg = res.message || 'Could not create company.';
      if (res.status === 503) {
        errMsg =
          'Server auth is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the web server .env.';
      }
      setMessage(errMsg);
      return;
    }
    setCreateCompanyName('');
    setCreateUsername('');
    setCreateEmail('');
    setCreatePassword('');
    setCreatePasswordConfirm('');
    let pending =
      res.message ||
      'Check your email to confirm. After confirming, you will set your company access code, then sign in with Log in.';
    if (res.dev) {
      pending += ' (Dev: confirmation link was logged on the server.)';
    }
    setPendingMessage(pending);
    clearMsg();
    setPanel('pending');
  }

  async function onSetupAccessCode() {
    clearMsg();
    const code = setupAccessCodeValue.trim();
    if (!code) {
      setMessage('Enter an access code.');
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage('Set EXPO_PUBLIC_GM_WEB_URL to your web server, then restart Expo.');
      return;
    }
    setBusy(true);
    const res = await portalSetupAccessCode(code);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message || 'Could not save access code.');
      return;
    }
    const savedAccessCode = res.accessCode || code;
    // Start the normal login flow: access code entry → name/password.
    await clearCompanySession();
    setVerifiedCompanyId('');
    setVerifiedAccessCode('');
    setVerifiedCompanyName('');
    setCompanyAccessCode(savedAccessCode);
    setSetupAccessCodeValue('');
    try {
      if (supabase) await supabase.auth.signOut({ scope: 'local' });
    } catch {
      /* ignore */
    }
    setSuccess(true);
    setMessage(
      res.message || 'Access code saved. Enter it below, then sign in with your username and password.'
    );
    setPanel('access-code');
  }

  async function onSignIn() {
    clearMsg();
    const name = loginName.trim();
    if (!name || !password) {
      setMessage('Enter your name and password.');
      return;
    }
    setBusy(true);
    let companyId = verifiedCompanyId || (await readStoredCompanyId());
    if (!companyId && isRedPokeAccessCode(verifiedAccessCode)) {
      companyId = RED_POKE_COMPANY_ID;
    }
    const res = await signIn(
      name,
      password,
      companyId || undefined,
      verifiedAccessCode || undefined
    );
    setBusy(false);
    if (!res.ok) {
      let msg = res.message || 'Sign in failed.';
      if (/PGRST116|multiple \(or no\) rows returned/i.test(msg)) {
        msg =
          'Multiple accounts match that name. Re-enter your company access code, then try again. If it still fails, ask an owner to clean up duplicate profiles.';
      }
      const hint =
        msg.includes('timed out') || msg.includes('Could not reach')
          ? `\n\nTrying: ${portalWebUrl()}`
          : '';
      setMessage(msg + hint);
      return;
    }
    if (companyId) {
      await storeCompanySession({ companyId });
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
        accessCode: verifiedAccessCode || undefined,
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
      accessCode: accessCode.trim() || verifiedAccessCode || undefined,
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
          <View style={styles.card}>
            {showRedPokeBrand ? (
              <View style={styles.logoWrap}>
                <Image
                  source={require('../assets/red-poke-logo.png')}
                  style={styles.companyLogo}
                  resizeMode="contain"
                  accessibilityLabel="Red Poke"
                />
              </View>
            ) : (
              <View style={styles.brandWrap} accessibilityElementsHidden>
                <View style={styles.brandMark}>
                  <Text style={styles.brandMarkText}>S</Text>
                </View>
              </View>
            )}

            <Text style={styles.title}>
              {showRedPokeBrand ? verifiedCompanyName || 'Red Poke' : 'Shiflow'}
            </Text>

            {!supabaseOk ? (
              <Text style={styles.warn}>
                Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY
                in mobile/.env (or EAS secrets for production builds).
              </Text>
            ) : !portalOk ? (
              <Text style={styles.warn}>
                Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env (HTTPS production or LAN IP), then restart Expo
                with -c.
              </Text>
            ) : null}

            {panel === 'landing' ? (
              <>
                <Text style={styles.subtitle}>Staff scheduling for restaurants</Text>
                <View style={styles.landingActions}>
                  <Pressable
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={() => {
                      clearMsg();
                      setPanel('access-code');
                    }}
                  >
                    <Text style={styles.buttonText}>Log in</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.buttonSecondary]}
                    onPress={() => {
                      clearMsg();
                      setPanel('create-company');
                    }}
                  >
                    <Text style={styles.buttonSecondaryText}>Create company</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {panel === 'access-code' ? (
              <>
                <Text style={styles.subtitle}>Enter your company access code</Text>
                <Text style={styles.hint}>Your manager can share this code with you.</Text>
                <Text style={styles.label}>Access code</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  value={companyAccessCode}
                  onChangeText={setCompanyAccessCode}
                  placeholder="Company access code"
                  placeholderTextColor="#888"
                  returnKeyType="go"
                  onSubmitEditing={() => void onVerifyAccessCode()}
                />
                {message ? (
                  <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                ) : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onVerifyAccessCode()}
                  disabled={busy || !portalOk}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Continue</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>Back</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'create-company' ? (
              <>
                <Text style={styles.subtitle}>Create your company</Text>
                <Text style={styles.hint}>
                  Set up Shiflow for your team. We will email you to confirm before you can sign in.
                </Text>
                <Text style={styles.label}>Company name</Text>
                <TextInput
                  style={styles.input}
                  value={createCompanyName}
                  onChangeText={setCreateCompanyName}
                  autoCapitalize="words"
                  maxLength={120}
                />
                <Text style={styles.label}>Your username</Text>
                <TextInput
                  style={styles.input}
                  value={createUsername}
                  onChangeText={setCreateUsername}
                  autoCapitalize="none"
                  autoComplete="username"
                  maxLength={80}
                />
                <Text style={styles.label}>Your email</Text>
                <TextInput
                  style={styles.input}
                  value={createEmail}
                  onChangeText={setCreateEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  maxLength={120}
                />
                <Text style={styles.label}>Password</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={createPassword}
                  onChangeText={setCreatePassword}
                  autoComplete="new-password"
                />
                <Text style={styles.label}>Confirm password</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={createPasswordConfirm}
                  onChangeText={setCreatePasswordConfirm}
                  autoComplete="new-password"
                />
                {message ? <Text style={styles.feedback}>{message}</Text> : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onCreateCompany()}
                  disabled={busy || !portalOk}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Create company</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>Back</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'pending' ? (
              <>
                <Text style={styles.subtitle}>Confirm your email</Text>
                <Text style={styles.hint}>{pendingMessage}</Text>
                <Text style={styles.hint}>
                  After you tap the email link, open this app (or the web page) to set your access code.
                </Text>
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => {
                    clearMsg();
                    setPanel('setup-access-code');
                  }}
                >
                  <Text style={styles.buttonText}>I confirmed — set access code</Text>
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>Back to home</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'setup-access-code' ? (
              <>
                <Text style={styles.subtitle}>Set your company access code</Text>
                <Text style={styles.hint}>
                  Choose a unique access code. Your team will enter it before signing in. Open the
                  confirmation link from your email on this device (or in a private browser window on
                  the web) so the correct account is signed in.
                </Text>
                <Text style={styles.label}>Company access code</Text>
                <TextInput
                  style={styles.input}
                  value={setupAccessCodeValue}
                  onChangeText={setSetupAccessCodeValue}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={48}
                  placeholder="e.g. my-restaurant"
                  placeholderTextColor="#94a3b8"
                />
                {message ? (
                  <Text style={[styles.feedback, success && styles.feedbackOk]}>{message}</Text>
                ) : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onSetupAccessCode()}
                  disabled={busy || !portalOk}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>Save access code</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>Back to home</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'signin' ? (
              <>
                <Text style={styles.subtitle}>Sign in to continue</Text>
                <Text style={styles.hint}>
                  Sign in with your name and password
                  {verifiedCompanyName ? ` for ${verifiedCompanyName}` : ''}.
                </Text>
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
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('employee-reg');
                  }}
                >
                  <Text style={styles.linkText}>Create employee account</Text>
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('manager-reg');
                  }}
                >
                  <Text style={styles.linkText}>Create manager account</Text>
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>Back to home</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'forgot' ? (
              <>
                <Text style={styles.subtitle}>Reset password</Text>
                <Text style={styles.hint}>
                  Enter your sign-in name. We email a reset link to the recovery email on that account.
                </Text>
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
              </>
            ) : null}

            {panel === 'employee-reg' ? (
              <>
                <Text style={styles.subtitle}>Create employee account</Text>
                <Text style={styles.label}>First name</Text>
                <TextInput
                  style={styles.input}
                  value={firstName}
                  onChangeText={setFirstName}
                  autoCapitalize="words"
                />
                <Text style={styles.label}>Last name</Text>
                <TextInput
                  style={styles.input}
                  value={lastName}
                  onChangeText={setLastName}
                  autoCapitalize="words"
                />
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
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={regPassword}
                  onChangeText={setRegPassword}
                />
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
              </>
            ) : null}

            {panel === 'manager-reg' ? (
              <>
                <Text style={styles.subtitle}>Create manager account</Text>
                <Text style={styles.hint}>
                  Enter the access code, your name, recovery email, and password.
                </Text>
                <Text style={styles.label}>Access code</Text>
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={accessCode}
                  onChangeText={setAccessCode}
                  autoCapitalize="none"
                />
                <Text style={styles.label}>Name</Text>
                <TextInput
                  style={styles.input}
                  value={mgrName}
                  onChangeText={setMgrName}
                  autoCapitalize="words"
                />
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
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  value={mgrPassword}
                  onChangeText={setMgrPassword}
                />
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
              </>
            ) : null}
          </View>
        </ScrollView>
        <StatusBar style="dark" />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#e8eef5' },
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    padding: 20,
    paddingBottom: 40,
    justifyContent: 'center',
  },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#e8eef5' },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 24,
    borderWidth: 1,
    borderColor: '#e8eaef',
    maxWidth: 400,
    width: '100%',
    alignSelf: 'center',
    shadowColor: '#0f172a',
    shadowOpacity: 0.1,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 4,
  },
  brandWrap: { alignItems: 'center', marginBottom: 12 },
  brandMark: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: PRIMARY,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: PRIMARY,
    shadowOpacity: 0.22,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  brandMarkText: {
    color: '#fff',
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
  },
  logoWrap: { alignItems: 'center', marginBottom: 12 },
  companyLogo: { width: 96, height: 96 },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: '#0f172a',
    marginBottom: 6,
    letterSpacing: -0.4,
  },
  subtitle: { fontSize: 14, color: '#475569', marginBottom: 18, lineHeight: 20 },
  hint: { fontSize: 13, color: '#64748b', marginBottom: 14, lineHeight: 19, marginTop: -8 },
  hintTight: { fontSize: 12, color: '#64748b', marginBottom: 10, marginTop: -6 },
  landingActions: { gap: 12, marginTop: 4 },
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
  button: { borderRadius: 8, paddingVertical: 14, alignItems: 'center' },
  buttonPrimary: { backgroundColor: PRIMARY },
  buttonSecondary: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: 'rgba(30, 58, 95, 0.22)',
  },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  buttonSecondaryText: { color: PRIMARY, fontSize: 16, fontWeight: '600' },
  feedback: { color: '#b00020', marginBottom: 8, fontSize: 14, lineHeight: 20 },
  feedbackOk: { color: '#166534' },
  linkBtn: { marginTop: 14, alignItems: 'center' },
  linkText: { color: PRIMARY, fontWeight: '600', fontSize: 15 },
  warn: { fontSize: 14, color: '#444', lineHeight: 22, marginBottom: 12 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 14 },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#f8fafc',
  },
  chipOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  chipText: { fontSize: 12, color: '#334155', fontWeight: '600' },
  chipTextOn: { color: '#fff' },
});
