import { useRouter, useLocalSearchParams } from 'expo-router';
import React, { useEffect, useState } from 'react';
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
import { useI18n } from '../contexts/LocaleContext';
import { LanguageToggle } from '../components/LanguageToggle';
import { isAdminRole, isManagerLikeRole } from '../lib/roles';
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
  portalTimeclockUrl,
  portalVerifyAccessCode,
  portalWebUrl,
} from '../lib/portalAuth';
import { friendlyAuthTokenMessage, isInvalidAuthTokenError } from '../lib/authErrors';
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

const STAFF_TYPE_VALUES = ['Kitchen', 'Bartender', 'Server'] as const;

const PRIMARY = '#1e3a5f';
/** Near-black so secureTextEntry bullets stay visible on light fields (Android OEM themes). */
const INPUT_TEXT = '#020617';
const INPUT_PLACEHOLDER = '#94a3b8';

/** Password fields need an explicit text color on Android or dots can be invisible under dark system themes. */
function PasswordInput({
  style,
  autoComplete = 'password',
  textContentType = 'password',
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

export default function LoginScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ setup_access_code?: string }>();
  const { signIn, signUp, session, role, loading: authLoading } = useAuth();
  const { t, locale, staffTypeLabel } = useI18n();
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
    if (session && isAdminRole(role)) router.replace('/manager/schedule');
    else if (session && isManagerLikeRole(role)) router.replace('/manager');
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

  async function openTimeClock() {
    clearMsg();
    const url = portalTimeclockUrl();
    if (!url) {
      setMessage(t('auth.portalEnvHint'));
      return;
    }
    try {
      await Linking.openURL(url);
    } catch {
      setMessage(t('auth.portalEnvHint'));
    }
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
      setMessage(t('auth.enterAccessCodeError'));
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
      setMessage(res.message || t('auth.accessCodeIncorrect'));
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
      setMessage(t('auth.allFieldsRequired'));
      return;
    }
    if (createPassword !== createPasswordConfirm) {
      setMessage(t('auth.passwordsMismatch'));
      return;
    }
    if (createPassword.length < 4) {
      setMessage(t('auth.passwordMinLength'));
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage(t('auth.portalNotConfigured'));
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
      let errMsg = res.message || t('auth.couldNotCreateCompany');
      if (res.status === 503) {
        errMsg = t('auth.serverAuthNotConfigured');
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
      t('auth.checkEmailConfirm');
    if (res.dev) {
      pending += t('auth.devConfirmLogged');
    }
    setPendingMessage(pending);
    clearMsg();
    setPanel('pending');
  }

  async function onSetupAccessCode() {
    clearMsg();
    const code = setupAccessCodeValue.trim();
    if (!code) {
      setMessage(t('auth.enterAccessCodeField'));
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage(t('auth.portalNotConfigured'));
      return;
    }
    setBusy(true);
    const res = await portalSetupAccessCode(code);
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message || t('auth.couldNotSaveAccessCode'));
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
      res.message || t('auth.accessCodeSavedHint')
    );
    setPanel('access-code');
  }

  async function onSignIn() {
    clearMsg();
    const name = loginName.trim();
    if (!name || !password) {
      setMessage(t('auth.enterNamePassword'));
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
      let msg = res.message || t('auth.signInFailed');
      if (/PGRST116|multiple \(or no\) rows returned/i.test(msg)) {
        msg = t('auth.multipleAccountsMatch');
      } else if (isInvalidAuthTokenError(msg) || /^invalid token$/i.test(msg)) {
        msg = friendlyAuthTokenMessage(msg, 'signin', locale);
      }
      const hint =
        msg.includes('timed out') || msg.includes('Could not reach')
          ? t('auth.tryingUrl', { url: portalWebUrl() })
          : '';
      setMessage(msg + hint);
      return;
    }
    if (companyId) {
      await storeCompanySession({ companyId });
    }
    router.replace(
      isAdminRole(res.role)
        ? '/manager/schedule'
        : isManagerLikeRole(res.role)
          ? '/manager'
          : res.role === 'employee'
            ? '/employee'
            : '/'
    );
  }

  async function onForgot() {
    clearMsg();
    const name = loginName.trim();
    if (!name) {
      setMessage(t('auth.enterSignInName'));
      return;
    }
    if (!isPortalAuthConfigured()) {
      setMessage(t('auth.portalNotConfigured'));
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
        t('auth.resetEmailSent')
    );
  }

  async function onEmployeeRegister() {
    clearMsg();
    const fn = firstName.trim();
    const ln = lastName.trim();
    const displayName = `${fn} ${ln}`.trim();
    if (!displayName) {
      setMessage(t('auth.firstLastRequired'));
      return;
    }
    if (!phone.trim()) {
      setMessage(t('auth.phoneRequired'));
      return;
    }
    if (!recoveryEmail.trim()) {
      setMessage(t('auth.recoveryEmailRequired'));
      return;
    }
    if (regPassword.length < 4) {
      setMessage(t('auth.passwordMinLength'));
      return;
    }
    if (regPassword !== regPasswordConfirm) {
      setMessage(t('auth.passwordsMismatch'));
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
      { firstName: fn, lastName: ln, phone: phone.trim(), staffType, email: recoveryEmail.trim() }
    );
    setBusy(false);
    if (!res.ok) {
      setMessage(res.message);
      return;
    }
    if (res.needsSignIn) {
      setSuccess(true);
      setMessage(res.message || t('auth.accountCreatedSignIn'));
      goSignIn(displayName);
      return;
    }
    router.replace('/');
  }

  async function onManagerRegister() {
    clearMsg();
    const name = mgrName.trim();
    if (!name) {
      setMessage(t('auth.nameRequired'));
      return;
    }
    if (!mgrRecoveryEmail.trim()) {
      setMessage(t('auth.recoveryEmailRequired'));
      return;
    }
    if (mgrPassword.length < 4) {
      setMessage(t('auth.passwordMinLength'));
      return;
    }
    if (mgrPassword !== mgrPasswordConfirm) {
      setMessage(t('auth.passwordsMismatch'));
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
      setMessage(res.message || t('auth.accountCreatedSignIn'));
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
            <View style={styles.langRow}>
              <LanguageToggle variant="compact" />
            </View>
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
              {panel === 'signin' && verifiedCompanyName
                ? verifiedCompanyName
                : showRedPokeBrand
                  ? 'Red Poke'
                  : 'Shiflow'}
            </Text>

            {!supabaseOk ? (
              <Text style={styles.warn}>{t('auth.supabaseNotConfigured')}</Text>
            ) : !portalOk ? (
              <Text style={styles.warn}>{t('auth.portalEnvHint')}</Text>
            ) : null}

            {panel === 'landing' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.tagline')}</Text>
                <View style={styles.landingActions}>
                  <Pressable
                    style={[styles.button, styles.buttonPrimary]}
                    onPress={() => {
                      clearMsg();
                      setPanel('access-code');
                    }}
                  >
                    <Text style={styles.buttonText}>{t('auth.logIn')}</Text>
                  </Pressable>
                  <Pressable
                    style={[styles.button, styles.buttonSecondary]}
                    onPress={() => {
                      clearMsg();
                      setPanel('create-company');
                    }}
                  >
                    <Text style={styles.buttonSecondaryText}>{t('auth.createCompany')}</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {panel === 'access-code' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.enterAccessCode')}</Text>
                <Text style={styles.hint}>{t('auth.accessCodeHint')}</Text>
                <Text style={styles.label}>{t('auth.accessCode')}</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  value={companyAccessCode}
                  onChangeText={setCompanyAccessCode}
                  placeholder={t('auth.accessCodePlaceholder')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
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
                    <Text style={styles.buttonText}>{t('common.continue')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>{t('common.back')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'create-company' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.createCompanyTitle')}</Text>
                <Text style={styles.hint}>{t('auth.createCompanyHint')}</Text>
                <Text style={styles.label}>{t('auth.companyName')}</Text>
                <TextInput
                  style={styles.input}
                  value={createCompanyName}
                  onChangeText={setCreateCompanyName}
                  autoCapitalize="words"
                  maxLength={120}
                />
                <Text style={styles.label}>{t('auth.yourUsername')}</Text>
                <TextInput
                  style={styles.input}
                  value={createUsername}
                  onChangeText={setCreateUsername}
                  autoCapitalize="none"
                  autoComplete="username"
                  maxLength={80}
                />
                <Text style={styles.label}>{t('auth.yourEmail')}</Text>
                <TextInput
                  style={styles.input}
                  value={createEmail}
                  onChangeText={setCreateEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                  maxLength={120}
                />
                <Text style={styles.label}>{t('auth.password')}</Text>
                <PasswordInput
                  value={createPassword}
                  onChangeText={setCreatePassword}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.password')}
                />
                <Text style={styles.label}>{t('auth.confirmPassword')}</Text>
                <PasswordInput
                  value={createPasswordConfirm}
                  onChangeText={setCreatePasswordConfirm}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.confirmPassword')}
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
                    <Text style={styles.buttonText}>{t('auth.createCompany')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>{t('common.back')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'pending' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.confirmEmail')}</Text>
                <Text style={styles.hint}>{pendingMessage}</Text>
                <Text style={styles.hint}>{t('auth.afterEmailLink')}</Text>
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => {
                    clearMsg();
                    setPanel('setup-access-code');
                  }}
                >
                  <Text style={styles.buttonText}>{t('auth.confirmedSetAccessCode')}</Text>
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>{t('auth.backToHome')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'setup-access-code' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.setupAccessCode')}</Text>
                <Text style={styles.hint}>{t('auth.setupAccessCodeLongHint')}</Text>
                <Text style={styles.label}>{t('auth.companyAccessCode')}</Text>
                <TextInput
                  style={styles.input}
                  value={setupAccessCodeValue}
                  onChangeText={setSetupAccessCodeValue}
                  autoCapitalize="none"
                  autoCorrect={false}
                  maxLength={48}
                  placeholder={t('auth.accessCodeExample')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
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
                    <Text style={styles.buttonText}>{t('auth.saveAccessCode')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>{t('auth.backToHome')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'signin' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.signInContinue')}</Text>
                <Text style={styles.label}>{t('auth.nameLabel')}</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="words"
                  autoComplete="username"
                  value={loginName}
                  onChangeText={setLoginName}
                  placeholder={t('auth.yourFullName')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
                />
                <Text style={styles.label}>{t('auth.password')}</Text>
                <PasswordInput
                  value={password}
                  onChangeText={setPassword}
                  placeholder={t('auth.password')}
                  returnKeyType="go"
                  onSubmitEditing={() => void onSignIn()}
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
                    <Text style={styles.buttonText}>{t('auth.signIn')}</Text>
                  )}
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('forgot');
                  }}
                >
                  <Text style={styles.linkText}>{t('auth.forgotPassword')}</Text>
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('employee-reg');
                  }}
                >
                  <Text style={styles.linkText}>{t('auth.createEmployeeAccount')}</Text>
                </Pressable>
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    clearMsg();
                    setPanel('manager-reg');
                  }}
                >
                  <Text style={styles.linkText}>{t('auth.createManagerAccount')}</Text>
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={goLanding}>
                  <Text style={styles.linkText}>{t('auth.backToHome')}</Text>
                </Pressable>
                <View style={styles.deviceSignIn}>
                  <Pressable
                    style={styles.deviceLinkBtn}
                    onPress={() => void openTimeClock()}
                    accessibilityRole="link"
                    accessibilityLabel={t('auth.timeclockTabletSignIn')}
                  >
                    <Text style={styles.deviceLinkText}>{t('auth.timeclockTabletSignIn')}</Text>
                  </Pressable>
                </View>
              </>
            ) : null}

            {panel === 'forgot' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.forgotTitle')}</Text>
                <Text style={styles.hint}>{t('auth.forgotHintLong')}</Text>
                <Text style={styles.label}>{t('auth.nameLabel')}</Text>
                <TextInput
                  style={styles.input}
                  autoCapitalize="words"
                  value={loginName}
                  onChangeText={setLoginName}
                  placeholder={t('auth.yourSignInName')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
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
                    <Text style={styles.buttonText}>{t('auth.sendResetLink')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>{t('auth.backToSignIn')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'employee-reg' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.registerEmployeeTitle')}</Text>
                <Text style={styles.label}>{t('auth.firstName')}</Text>
                <TextInput
                  style={styles.input}
                  value={firstName}
                  onChangeText={setFirstName}
                  autoCapitalize="words"
                />
                <Text style={styles.label}>{t('auth.lastName')}</Text>
                <TextInput
                  style={styles.input}
                  value={lastName}
                  onChangeText={setLastName}
                  autoCapitalize="words"
                />
                <Text style={styles.label}>{t('auth.phoneNumber')}</Text>
                <TextInput
                  style={styles.input}
                  value={phone}
                  onChangeText={setPhone}
                  keyboardType="phone-pad"
                  autoComplete="tel"
                />
                <Text style={styles.label}>{t('auth.recoveryEmail')}</Text>
                <TextInput
                  style={styles.input}
                  value={recoveryEmail}
                  onChangeText={setRecoveryEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
                <Text style={styles.hintTight}>{t('auth.recoveryHintShort')}</Text>
                <Text style={styles.label}>{t('auth.staffType')}</Text>
                <View style={styles.chipRow}>
                  {STAFF_TYPE_VALUES.map((st) => {
                    const on = staffType === st;
                    return (
                      <Pressable
                        key={st}
                        style={[styles.chip, on && styles.chipOn]}
                        onPress={() => setStaffType(st)}
                      >
                        <Text style={[styles.chipText, on && styles.chipTextOn]}>{staffTypeLabel(st)}</Text>
                      </Pressable>
                    );
                  })}
                </View>
                <Text style={styles.label}>{t('auth.password')}</Text>
                <PasswordInput
                  value={regPassword}
                  onChangeText={setRegPassword}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.password')}
                />
                <Text style={styles.label}>{t('auth.confirmPassword')}</Text>
                <PasswordInput
                  value={regPasswordConfirm}
                  onChangeText={setRegPasswordConfirm}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.confirmPassword')}
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
                    <Text style={styles.buttonText}>{t('auth.createAccount')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>{t('auth.backToSignIn')}</Text>
                </Pressable>
              </>
            ) : null}

            {panel === 'manager-reg' ? (
              <>
                <Text style={styles.subtitle}>{t('auth.registerManagerTitle')}</Text>
                <Text style={styles.hint}>{t('auth.managerRegHint')}</Text>
                <Text style={styles.label}>{t('auth.accessCode')}</Text>
                <TextInput
                  style={styles.input}
                  value={accessCode}
                  onChangeText={setAccessCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  placeholder={t('auth.accessCode')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
                />
                <Text style={styles.label}>{t('auth.nameLabel')}</Text>
                <TextInput
                  style={styles.input}
                  value={mgrName}
                  onChangeText={setMgrName}
                  autoCapitalize="words"
                />
                <Text style={styles.label}>{t('auth.recoveryEmail')}</Text>
                <TextInput
                  style={styles.input}
                  value={mgrRecoveryEmail}
                  onChangeText={setMgrRecoveryEmail}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoComplete="email"
                />
                <Text style={styles.hintTight}>{t('auth.recoveryHintShort')}</Text>
                <Text style={styles.label}>{t('auth.password')}</Text>
                <PasswordInput
                  value={mgrPassword}
                  onChangeText={setMgrPassword}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.password')}
                />
                <Text style={styles.label}>{t('auth.confirmPassword')}</Text>
                <PasswordInput
                  value={mgrPasswordConfirm}
                  onChangeText={setMgrPasswordConfirm}
                  autoComplete="new-password"
                  textContentType="newPassword"
                  placeholder={t('auth.confirmPassword')}
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
                    <Text style={styles.buttonText}>{t('auth.createManagerAccountBtn')}</Text>
                  )}
                </Pressable>
                <Pressable style={styles.linkBtn} onPress={() => goSignIn()}>
                  <Text style={styles.linkText}>{t('auth.backToSignIn')}</Text>
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
  langRow: { alignItems: 'flex-end', marginBottom: 8 },
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
    // Explicit color required on Android: system dark theme can make default text
    // (and secureTextEntry bullets) inherit a near-white color on #fafbfc.
    color: INPUT_TEXT,
    marginBottom: 14,
    backgroundColor: '#ffffff',
    ...(Platform.OS === 'android'
      ? {
          minHeight: 48,
          // Avoid clipping password bullets / descenders on some Android OEM fonts.
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
  deviceSignIn: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: '#e8ecef',
    alignItems: 'center',
  },
  deviceLinkBtn: { paddingVertical: 4, alignItems: 'center' },
  deviceLinkText: { color: '#6b7280', fontWeight: '500', fontSize: 13 },
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
