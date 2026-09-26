import { useRouter, type ErrorBoundaryProps } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaView } from 'react-native-safe-area-context';
import { RouteErrorFallback } from '../components/RouteErrorFallback';
import { useAuth } from '../contexts/AuthContext';
import { useI18n } from '../contexts/LocaleContext';
import {
  isRedPokeAccessCode,
  readStoredAccessCode,
  readStoredCompanyId,
  RED_POKE_COMPANY_ID,
} from '../lib/companySession';
import { canUseTimeclock } from '../lib/roles';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

const PRIMARY = '#1e3a5f';
const INPUT_TEXT = '#020617';
const INPUT_PLACEHOLDER = '#94a3b8';
const RPC_TIMEOUT_MS = 15000;

type StoreId = 'rp-9' | 'rp-8';
type PunchAction = 'in' | 'out' | 'break_start' | 'break_end';

type LookupData = {
  ok?: boolean;
  error?: string;
  display_name?: string;
  is_clocked_in?: boolean;
  on_break?: boolean;
};

type PunchData = LookupData & {
  action?: string;
  at?: string;
};

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'del'] as const;

function actionsFor(data: LookupData): PunchAction[] {
  if (!data.is_clocked_in) return ['in'];
  if (data.on_break) return ['out', 'break_end'];
  return ['out', 'break_start'];
}

async function rpc<T>(fn: string, args: Record<string, string>): Promise<{ data: T | null; error: string | null }> {
  if (!supabase) return { data: null, error: 'Supabase is not configured.' };
  const call = supabase.rpc(fn, args).then((res) => {
    if (res.error) return { data: null as T | null, error: res.error.message || 'Request failed.' };
    return { data: (res.data ?? null) as T | null, error: null };
  });
  const timeout = new Promise<{ data: T | null; error: string }>((resolve) => {
    setTimeout(() => resolve({ data: null, error: 'timeout' }), RPC_TIMEOUT_MS);
  });
  return Promise.race([call, timeout]);
}

export default function TimeclockScreen() {
  const router = useRouter();
  const { t } = useI18n();
  const { session, role, loading: authLoading, signIn, signOut } = useAuth();
  const [store, setStore] = useState<StoreId>('rp-9');
  const [pin, setPin] = useState('');
  const [phase, setPhase] = useState<'enter' | 'confirm'>('enter');
  const [lookup, setLookup] = useState<LookupData | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [statusKind, setStatusKind] = useState<'ok' | 'err' | ''>('');
  const [recent, setRecent] = useState<string[]>([]);
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [companyId, setCompanyId] = useState('');
  const [accessCode, setAccessCode] = useState('');
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupPinRef = useRef('');

  useEffect(() => {
    void (async () => {
      const [id, code] = await Promise.all([readStoredCompanyId(), readStoredAccessCode()]);
      setCompanyId(id);
      setAccessCode(code);
    })();
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    };
  }, []);

  function clearReset() {
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = null;
  }

  function scheduleReset(ms: number) {
    clearReset();
    lookupPinRef.current = '';
    resetTimer.current = setTimeout(() => {
      setPin('');
      setLookup(null);
      setPhase('enter');
      setStatus('');
      setStatusKind('');
    }, ms);
  }

  function lookupError(data: LookupData | null): string {
    if (data?.error === 'unknown_pin') return t('clock.pinNotRecognized');
    if (data?.error === 'invalid_pin') return t('clock.enterFour');
    return t('clock.couldNotVerify');
  }

  function punchError(data: PunchData | null): string {
    const name = data?.display_name || t('common.employee');
    if (data?.error === 'already_in') return t('clock.alreadyIn', { name });
    if (data?.error === 'not_in') return t('clock.notIn', { name });
    if (data?.error === 'already_on_break') return t('clock.alreadyOnBreak', { name });
    if (data?.error === 'not_on_break') return t('clock.notOnBreak', { name });
    if (data?.error === 'unknown_pin') return t('clock.pinNotRecognized');
    if (data?.error === 'invalid_pin') return t('clock.enterFour');
    return t('clock.punchFailed');
  }

  async function lookupPin(nextPin: string) {
    setBusy(true);
    setStatus(t('clock.checking'));
    setStatusKind('');
    const res = await rpc<LookupData>('timeclock_lookup_pin', { pin_input: nextPin });
    setBusy(false);
    if (res.error) {
      setStatus(res.error === 'timeout' ? t('clock.timeout') : res.error);
      setStatusKind('err');
      scheduleReset(4000);
      return;
    }
    if (!res.data?.ok) {
      setStatus(lookupError(res.data));
      setStatusKind('err');
      scheduleReset(4000);
      return;
    }
    setLookup(res.data);
    setPhase('confirm');
    setStatus('');
  }

  async function confirm(action: PunchAction) {
    if (!lookup || busy) return;
    setBusy(true);
    setStatus(t('clock.saving'));
    setStatusKind('');
    let res = await rpc<PunchData>('timeclock_punch_with_action', {
      pin_input: pin,
      punch_action: action,
      p_restaurant_id: store,
    });
    if (res.error && /p_restaurant_id|schema cache|Could not find the function/i.test(res.error)) {
      res = await rpc<PunchData>('timeclock_punch_with_action', {
        pin_input: pin,
        punch_action: action,
      });
    }
    setBusy(false);
    if (res.error) {
      setStatus(res.error === 'timeout' ? t('clock.timeout') : res.error);
      setStatusKind('err');
      return;
    }
    if (!res.data?.ok) {
      setStatus(punchError(res.data));
      setStatusKind('err');
      return;
    }
    const name = String(res.data.display_name || '').trim();
    const verb =
      res.data.action === 'out'
        ? t('clock.successOut')
        : res.data.action === 'break_start'
          ? t('clock.breakStarted')
          : res.data.action === 'break_end'
            ? t('clock.breakEnded')
            : t('clock.successIn');
    const when = res.data.at
      ? new Date(res.data.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : '';
    setStatus(`${verb} — ${name}`);
    setStatusKind('ok');
    setRecent((prev) => [`${when ? when + ' · ' : ''}${verb} — ${name}`, ...prev].slice(0, 6));
    lookupPinRef.current = '';
    setPin('');
    setLookup(null);
    setPhase('enter');
    scheduleReset(3500);
  }

  function onKey(key: (typeof KEYS)[number]) {
    if (busy || phase !== 'enter') return;
    clearReset();
    setStatus('');
    setStatusKind('');
    if (key === 'clear') {
      lookupPinRef.current = '';
      setPin('');
      return;
    }
    if (key === 'del') {
      lookupPinRef.current = '';
      setPin((prev) => prev.slice(0, -1));
      return;
    }
    setPin((prev) => (prev.length >= 4 ? prev : prev + key));
  }

  useEffect(() => {
    if (phase !== 'enter' || pin.length !== 4 || busy) return;
    if (lookupPinRef.current === pin) return;
    lookupPinRef.current = pin;
    void lookupPin(pin);
    // lookupPin closes over the latest translators; pin length is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, phase]);

  async function onClockSignIn() {
    const name = loginName.trim();
    if (!name || !password) {
      setStatus(t('auth.enterNamePassword'));
      setStatusKind('err');
      return;
    }
    let cid = companyId;
    if (!cid && isRedPokeAccessCode(accessCode)) cid = RED_POKE_COMPANY_ID;
    if (!cid && !accessCode) {
      setStatus(t('clock.needCompany'));
      setStatusKind('err');
      return;
    }
    setBusy(true);
    setStatus('');
    const res = await signIn(name, password, cid || undefined, accessCode || undefined);
    setBusy(false);
    if (!res.ok) {
      setStatus(res.message || t('auth.signInFailed'));
      setStatusKind('err');
      return;
    }
    setPassword('');
    if (!canUseTimeclock(res.role)) {
      setStatus(t('clock.notAllowed'));
      setStatusKind('err');
    }
  }

  const ready = canUseTimeclock(role);
  const actions = lookup ? actionsFor(lookup) : [];
  const hint =
    actions.length === 1 && actions[0] === 'in'
      ? t('clock.confirmIn')
      : actions.includes('break_end')
        ? t('clock.chooseOutOrEnd')
        : t('clock.chooseOutOrStart');

  if (authLoading) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color={PRIMARY} />
        <StatusBar style="dark" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>{t('clock.title')}</Text>
        {!isSupabaseConfigured ? <Text style={styles.err}>{t('clock.notConfigured')}</Text> : null}

        {!ready ? (
          <View style={styles.card}>
            <Text style={styles.hint}>
              {session && role ? t('clock.notAllowed') : t('clock.signInHint')}
            </Text>
            {!session ? (
              <>
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
                <TextInput
                  style={styles.input}
                  secureTextEntry
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={password}
                  onChangeText={setPassword}
                  placeholder={t('auth.password')}
                  placeholderTextColor={INPUT_PLACEHOLDER}
                />
                {status ? (
                  <Text style={[styles.status, statusKind === 'ok' && styles.ok, statusKind === 'err' && styles.err]}>
                    {status}
                  </Text>
                ) : null}
                <Pressable
                  style={[styles.button, styles.buttonPrimary]}
                  onPress={() => void onClockSignIn()}
                  disabled={busy}
                >
                  {busy ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <Text style={styles.buttonText}>{t('auth.signIn')}</Text>
                  )}
                </Pressable>
              </>
            ) : (
              <Pressable style={[styles.button, styles.buttonPrimary]} onPress={() => router.replace('/')}>
                <Text style={styles.buttonText}>{t('common.continue')}</Text>
              </Pressable>
            )}
            <Pressable style={styles.linkBtn} onPress={() => router.back()}>
              <Text style={styles.linkText}>{t('common.back')}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.card}>
            <Text style={styles.label}>{t('clock.store')}</Text>
            <View style={styles.storeRow}>
              {(['rp-9', 'rp-8'] as const).map((id) => (
                <Pressable
                  key={id}
                  style={[styles.chip, store === id && styles.chipOn]}
                  onPress={() => setStore(id)}
                >
                  <Text style={[styles.chipText, store === id && styles.chipTextOn]}>
                    {id === 'rp-9' ? t('clock.store9') : t('clock.store8')}
                  </Text>
                </Pressable>
              ))}
            </View>

            {phase === 'enter' ? (
              <>
                <Text style={styles.hint}>{t('clock.enterPin')}</Text>
                <Text style={styles.pin} accessibilityLabel={t('clock.enterPin')}>
                  {'●'.repeat(pin.length)}
                  {'○'.repeat(Math.max(0, 4 - pin.length))}
                </Text>
                <View style={styles.pad}>
                  {KEYS.map((key) => (
                    <Pressable
                      key={key}
                      style={styles.key}
                      onPress={() => onKey(key)}
                      disabled={busy}
                      accessibilityLabel={
                        key === 'clear' ? t('clock.clear') : key === 'del' ? t('clock.delete') : key
                      }
                    >
                      <Text style={styles.keyText}>
                        {key === 'clear' ? t('clock.clear') : key === 'del' ? '⌫' : key}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : (
              <>
                <Text style={styles.name}>{lookup?.display_name || ''}</Text>
                <Text style={styles.hint}>{hint}</Text>
                {actions.map((action) => (
                  <Pressable
                    key={action}
                    style={[styles.button, action === 'out' ? styles.buttonSecondary : styles.buttonPrimary]}
                    onPress={() => void confirm(action)}
                    disabled={busy}
                  >
                    <Text style={action === 'out' ? styles.buttonTextDark : styles.buttonText}>
                      {action === 'in'
                        ? t('clock.clockIn')
                        : action === 'out'
                          ? t('clock.clockOut')
                          : action === 'break_start'
                            ? t('clock.breakStart')
                            : t('clock.breakEnd')}
                    </Text>
                  </Pressable>
                ))}
                <Pressable
                  style={styles.linkBtn}
                  onPress={() => {
                    setPhase('enter');
                    setPin('');
                    setLookup(null);
                    setStatus('');
                  }}
                >
                  <Text style={styles.linkText}>{t('clock.clear')}</Text>
                </Pressable>
              </>
            )}

            {status ? (
              <Text style={[styles.status, statusKind === 'ok' && styles.ok, statusKind === 'err' && styles.err]}>
                {status}
              </Text>
            ) : null}
            {busy ? <ActivityIndicator color={PRIMARY} style={{ marginTop: 8 }} /> : null}

            {recent.length ? (
              <View style={styles.recent}>
                <Text style={styles.label}>{t('clock.recent')}</Text>
                {recent.map((line, i) => (
                  <Text key={`${i}-${line}`} style={styles.recentLine}>
                    {line}
                  </Text>
                ))}
              </View>
            ) : null}

            <Pressable
              style={styles.linkBtn}
              onPress={() => {
                void signOut().then(() => router.replace('/login'));
              }}
            >
              <Text style={styles.linkText}>{t('common.signOut')}</Text>
            </Pressable>
          </View>
        )}
      </ScrollView>
      <StatusBar style="dark" />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#e8eef5' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#e8eef5' },
  scroll: { flexGrow: 1, padding: 20, paddingBottom: 32 },
  title: { fontSize: 22, fontWeight: '700', color: PRIMARY, textAlign: 'center', marginBottom: 16 },
  card: {
    backgroundColor: '#fff',
    borderRadius: 8,
    padding: 20,
    borderWidth: 1,
    borderColor: '#e8eaef',
    maxWidth: 420,
    width: '100%',
    alignSelf: 'center',
  },
  label: { fontSize: 13, fontWeight: '600', color: '#334155', marginBottom: 6, marginTop: 8 },
  hint: { color: '#475569', marginBottom: 12, lineHeight: 20 },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    fontSize: 16,
    color: INPUT_TEXT,
    backgroundColor: '#fff',
    marginBottom: 8,
  },
  storeRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  chipOn: { backgroundColor: PRIMARY, borderColor: PRIMARY },
  chipText: { color: PRIMARY, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  pin: {
    textAlign: 'center',
    fontSize: 28,
    letterSpacing: 8,
    color: PRIMARY,
    marginBottom: 16,
  },
  pad: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' },
  key: {
    width: '31%',
    backgroundColor: '#f1f5f9',
    borderRadius: 8,
    paddingVertical: 16,
    alignItems: 'center',
    marginBottom: 10,
  },
  keyText: { fontSize: 20, fontWeight: '600', color: PRIMARY },
  name: { fontSize: 22, fontWeight: '700', color: '#0f172a', textAlign: 'center', marginBottom: 8 },
  button: { borderRadius: 8, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  buttonPrimary: { backgroundColor: PRIMARY },
  buttonSecondary: { backgroundColor: '#e2e8f0' },
  buttonText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  buttonTextDark: { color: PRIMARY, fontWeight: '700', fontSize: 16 },
  status: { marginTop: 12, textAlign: 'center', color: '#334155' },
  ok: { color: '#15803d', fontWeight: '600' },
  err: { color: '#b91c1c' },
  linkBtn: { marginTop: 14, alignItems: 'center' },
  linkText: { color: '#c41230', fontWeight: '600' },
  recent: { marginTop: 16 },
  recentLine: { color: '#475569', marginBottom: 4 },
});
