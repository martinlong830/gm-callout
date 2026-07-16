import { friendlyAuthTokenMessage, isInvalidAuthTokenError } from './authErrors';
import { supabase } from './supabase';

function portalApiBase(): string {
  const raw = process.env.EXPO_PUBLIC_GM_WEB_URL ?? '';
  return String(raw).trim().replace(/\/$/, '');
}

export function isPortalAuthConfigured(): boolean {
  return !!portalApiBase();
}

/** Configured portal / web origin (shown in login errors for debugging). */
export function portalWebUrl(): string {
  return portalApiBase() || '(not set)';
}

type PortalOk<T> = { ok: true } & T;
type PortalErr = { ok: false; message: string; needsSignIn?: boolean; status?: number };

function friendlyPortalErrorMessage(raw: string): string {
  const msg = String(raw || '').trim();
  if (!msg) return 'Request failed.';
  if (/PGRST116|multiple \(or no\) rows returned/i.test(msg)) {
    return 'Multiple accounts match that name. Re-enter your company access code, then try again.';
  }
  if (isInvalidAuthTokenError(msg) || /^invalid token$/i.test(msg)) {
    return friendlyAuthTokenMessage(msg, 'signin');
  }
  return msg;
}

/** Clear a bad persisted session without calling the network logout endpoint. */
export async function clearLocalAuthSession(): Promise<void> {
  if (!supabase) return;
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* ignore */
  }
}

async function portalPost<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>
): Promise<PortalOk<T> | PortalErr> {
  const base = portalApiBase();
  if (!base) {
    return {
      ok: false,
      message:
        'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server (e.g. http://192.168.1.10:8000), then restart Expo.',
    };
  }
  let data: Record<string, unknown> = {};
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    try {
      data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      return {
        ok: false,
        message:
          res.status >= 500
            ? 'Server error during sign-in. The web portal may need a redeploy.'
            : 'Unexpected response from the web server.',
        status: res.status,
      };
    }
    if (!res.ok || !data.ok) {
      let msg = friendlyPortalErrorMessage((data.message as string) || 'Request failed.');
      if (res.status === 503) {
        msg =
          msg ||
          'Server auth is not configured. Set SUPABASE_* on the web server and redeploy.';
      }
      return {
        ok: false,
        message: msg,
        needsSignIn: !!data.needsSignIn,
        status: res.status,
      };
    }
    return { ok: true, ...(data as T) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        ok: false,
        message:
          'Sign-in timed out. Check EXPO_PUBLIC_GM_WEB_URL (use your computer’s LAN IP, not localhost) and that the web server is running.',
      };
    }
    return {
      ok: false,
      message: 'Could not reach the web server. Check EXPO_PUBLIC_GM_WEB_URL and that npm start is running.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function applyPortalSession(tokens: {
  access_token: string;
  refresh_token?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const access = String(tokens.access_token || '').trim();
  const refresh = String(tokens.refresh_token || '').trim();
  if (!access || !refresh) {
    await clearLocalAuthSession();
    return {
      ok: false,
      message: friendlyAuthTokenMessage('Invalid token', 'signin'),
    };
  }
  // Drop any stale AsyncStorage session before applying portal tokens.
  await clearLocalAuthSession();
  const { error } = await supabase.auth.setSession({
    access_token: access,
    refresh_token: refresh,
  });
  if (error) {
    await clearLocalAuthSession();
    return {
      ok: false,
      message: friendlyAuthTokenMessage(error.message || 'Invalid token', 'signin'),
    };
  }
  return { ok: true };
}

export async function portalSignIn(
  loginName: string,
  password: string,
  companyId?: string,
  accessCode?: string
): Promise<
  | { ok: true; role?: string; displayName?: string; companyId?: string; companyName?: string }
  | { ok: false; message: string }
> {
  const body: Record<string, unknown> = {
    loginName: loginName.trim(),
    password,
  };
  if (companyId) body.companyId = companyId;
  if (accessCode) body.accessCode = String(accessCode).trim();
  const r = await portalPost<{
    access_token: string;
    refresh_token?: string;
    role?: string;
    displayName?: string;
    companyId?: string;
    companyName?: string;
  }>('/api/portal/signin', body);
  if (!r.ok) return { ok: false, message: friendlyPortalErrorMessage(r.message) };
  const applied = await applyPortalSession({
    access_token: r.access_token,
    refresh_token: r.refresh_token,
  });
  if (!applied.ok) return applied;
  return {
    ok: true,
    role: r.role,
    displayName: r.displayName,
    companyId: r.companyId,
    companyName: r.companyName,
  };
}

export async function portalVerifyAccessCode(accessCode: string): Promise<
  | {
      ok: true;
      companyId: string;
      companyName: string;
      accessCode: string;
      teamStateId: string;
      restaurantsConfig: unknown[];
    }
  | { ok: false; message: string }
> {
  const r = await portalPost<{
    companyId?: string;
    companyName?: string;
    accessCode?: string;
    teamStateId?: string;
    restaurantsConfig?: unknown[];
  }>('/api/portal/verify-access-code', { accessCode: String(accessCode || '').trim() });
  if (!r.ok) return r;
  return {
    ok: true,
    companyId: r.companyId || '',
    companyName: r.companyName || '',
    accessCode: r.accessCode || String(accessCode || '').trim(),
    teamStateId: r.teamStateId || '',
    restaurantsConfig: r.restaurantsConfig || [],
  };
}

export async function portalCreateCompany(payload: {
  companyName: string;
  username: string;
  email: string;
  password: string;
  passwordConfirm: string;
}): Promise<
  | {
      ok: true;
      pending?: boolean;
      needsAccessCodeSetup?: boolean;
      message: string;
      companyId?: string;
      accessCode?: string;
      emailSent?: boolean;
      dev?: boolean;
    }
  | { ok: false; message: string; status?: number }
> {
  const r = await portalPost<{
    pending?: boolean;
    needsAccessCodeSetup?: boolean;
    message?: string;
    companyId?: string;
    accessCode?: string;
    emailSent?: boolean;
    dev?: boolean;
  }>('/api/portal/create-company', payload as unknown as Record<string, unknown>);
  if (!r.ok) return r;
  return {
    ok: true,
    pending: !!r.pending,
    needsAccessCodeSetup: !!r.needsAccessCodeSetup,
    message: r.message || 'Check your email to confirm company creation.',
    companyId: r.companyId,
    accessCode: r.accessCode,
    emailSent: !!r.emailSent,
    dev: !!r.dev,
  };
}

export async function portalSetupAccessCode(
  accessCode: string
): Promise<
  | {
      ok: true;
      message: string;
      companyId?: string;
      companyName?: string;
      accessCode?: string;
      teamStateId?: string;
      restaurantsConfig?: unknown[];
    }
  | { ok: false; message: string }
> {
  if (!isPortalAuthConfigured()) {
    return { ok: false, message: 'Portal auth is not configured (EXPO_PUBLIC_GM_WEB_URL).' };
  }
  const r = await portalAuthedFetch<{
    message?: string;
    companyId?: string;
    companyName?: string;
    accessCode?: string;
    teamStateId?: string;
    restaurantsConfig?: unknown[];
  }>('POST', '/api/portal/setup-access-code', {
    accessCode: String(accessCode || '').trim(),
  });
  if (!r.ok) return r;
  return {
    ok: true,
    message: r.message || 'Access code saved.',
    companyId: r.companyId,
    companyName: r.companyName,
    accessCode: r.accessCode,
    teamStateId: r.teamStateId,
    restaurantsConfig: r.restaurantsConfig,
  };
}

function parseAuthParamsFromUrl(url: string | null | undefined): {
  access_token: string;
  refresh_token: string;
  code: string;
  error: string;
  error_description: string;
} {
  const out = {
    access_token: '',
    refresh_token: '',
    code: '',
    error: '',
    error_description: '',
  };
  if (!url) return out;
  try {
    const parsed = new URL(url);
    out.code = String(parsed.searchParams.get('code') || '').trim();
    out.access_token = String(parsed.searchParams.get('access_token') || '').trim();
    out.refresh_token = String(parsed.searchParams.get('refresh_token') || '').trim();
    out.error = String(parsed.searchParams.get('error') || '').trim();
    out.error_description = String(parsed.searchParams.get('error_description') || '').trim();
    const hash = String(parsed.hash || '').replace(/^#/, '');
    if (hash) {
      const hp = new URLSearchParams(hash);
      if (!out.access_token) out.access_token = String(hp.get('access_token') || '').trim();
      if (!out.refresh_token) out.refresh_token = String(hp.get('refresh_token') || '').trim();
      if (!out.code) out.code = String(hp.get('code') || '').trim();
      if (!out.error) out.error = String(hp.get('error') || '').trim();
      if (!out.error_description) {
        out.error_description = String(hp.get('error_description') || '').trim();
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * After create-company email confirm deep link, clear a conflicting prior session
 * and establish the newly confirmed user's session before setting the access code.
 */
export async function establishConfirmSessionForAccessCodeSetup(
  url?: string | null
): Promise<
  | { ok: true; loginName?: string; companyName?: string; needsAccessCodeSetup?: boolean }
  | { ok: false; message: string; alreadySet?: boolean; wrongAccount?: boolean }
> {
  if (!supabase) {
    return { ok: false, message: 'Supabase is not configured.' };
  }
  const params = parseAuthParamsFromUrl(url);
  if (params.error || params.error_description) {
    await clearLocalAuthSession();
    return {
      ok: false,
      message: friendlyAuthTokenMessage(
        params.error_description || params.error || 'Invalid token',
        'confirm'
      ),
    };
  }

  if (params.access_token && params.refresh_token) {
    const applied = await applyPortalSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    if (!applied.ok) {
      return {
        ok: false,
        message: friendlyAuthTokenMessage(applied.message, 'confirm'),
      };
    }
  } else if (params.code) {
    await clearLocalAuthSession();
    const exchanged = await supabase.auth.exchangeCodeForSession(params.code);
    if (exchanged.error || !exchanged.data.session) {
      return {
        ok: false,
        message: friendlyAuthTokenMessage(
          exchanged.error?.message || 'Invalid token',
          'confirm'
        ),
      };
    }
  }

  const sess = await supabase.auth.getSession();
  if (!sess.data.session) {
    return {
      ok: false,
      message:
        'Confirm your email first using the link we sent, then return here to set your access code. Prefer opening the link in the browser (or a private window).',
    };
  }

  const acct = await portalGetAccount();
  if (!acct.ok) {
    return {
      ok: false,
      message: acct.message || 'Could not load your account after confirmation.',
    };
  }
  if (acct.needsAccessCodeSetup) {
    return {
      ok: true,
      loginName: acct.loginName,
      companyName: acct.companyName,
      needsAccessCodeSetup: true,
    };
  }
  if (acct.isCompanyCreator) {
    return {
      ok: false,
      alreadySet: true,
      message: 'Your company access code is already set. Enter it to continue to sign in.',
    };
  }
  try {
    await supabase.auth.signOut({ scope: 'local' });
  } catch {
    /* ignore */
  }
  return {
    ok: false,
    wrongAccount: true,
    message:
      'This device was still signed in as a different account. Sign out completed — open the confirmation link from your email again (browser / private window recommended).',
  };
}

export async function portalUpdateCompany(payload: {
  name?: string;
  companyName?: string;
}): Promise<
  | { ok: true; message: string; companyId?: string; companyName?: string; accessCode?: string }
  | { ok: false; message: string }
> {
  if (!isPortalAuthConfigured()) {
    return { ok: false, message: 'Portal auth is not configured (EXPO_PUBLIC_GM_WEB_URL).' };
  }
  const r = await portalAuthedFetch<{
    message?: string;
    companyId?: string;
    companyName?: string;
    accessCode?: string;
  }>('PUT', '/api/portal/company', payload as unknown as Record<string, unknown>);
  if (!r.ok) return r;
  return {
    ok: true,
    message: r.message || 'Company updated.',
    companyId: r.companyId,
    companyName: r.companyName,
    accessCode: r.accessCode,
  };
}

export type PortalSignUpPayload = {
  loginName: string;
  password: string;
  role: 'manager' | 'employee';
  accessCode?: string;
  displayName?: string;
  phone?: string;
  staffType?: string;
  recoveryEmail?: string;
};

export async function portalSignUp(
  payload: PortalSignUpPayload
): Promise<
  | { ok: true; needsSignIn?: boolean; message?: string; role?: string; displayName?: string }
  | { ok: false; message: string }
> {
  const r = await portalPost<{
    access_token?: string;
    refresh_token?: string;
    needsSignIn?: boolean;
    message?: string;
    role?: string;
    displayName?: string;
  }>('/api/portal/signup', payload as unknown as Record<string, unknown>);
  if (!r.ok) return r;
  if (r.needsSignIn) {
    return { ok: true, needsSignIn: true, message: r.message };
  }
  if (r.access_token) {
    const applied = await applyPortalSession({
      access_token: r.access_token,
      refresh_token: r.refresh_token,
    });
    if (!applied.ok) return applied;
  }
  return { ok: true, role: r.role, displayName: r.displayName, message: r.message };
}

export async function portalRequestPasswordReset(
  loginName: string
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const r = await portalPost<{ message: string }>('/api/portal/forgot-password', {
    loginName: String(loginName || '').trim(),
  });
  if (!r.ok) return r;
  return { ok: true, message: r.message || 'If we found that name, we sent a reset link.' };
}

export async function portalVerifyResetToken(
  token: string
): Promise<{ ok: true; loginName: string } | { ok: false; message: string }> {
  const base = portalApiBase();
  if (!base) return { ok: false, message: 'Web server URL is not configured.' };
  try {
    const res = await fetch(
      `${base}/api/portal/reset-password/verify?token=${encodeURIComponent(String(token || '').trim())}`
    );
    const data = (await res.json()) as { ok?: boolean; message?: string; loginName?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, message: data.message || 'Reset link is invalid or expired.' };
    }
    return { ok: true, loginName: data.loginName || '' };
  } catch {
    return { ok: false, message: 'Could not verify reset link.' };
  }
}

export async function portalResetPassword(
  token: string,
  password: string
): Promise<
  | { ok: true; message: string; loginName: string }
  | { ok: false; message: string }
> {
  const r = await portalPost<{ message: string; loginName?: string }>('/api/portal/reset-password', {
    token: String(token || '').trim(),
    password: String(password || ''),
  });
  if (!r.ok) return r;
  return {
    ok: true,
    message: r.message || 'Password updated.',
    loginName: r.loginName || '',
  };
}

function isValidRecoveryEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

export async function portalGetAccount(): Promise<
  | {
      ok: true;
      loginName: string;
      recoveryEmail: string;
      hasRecoveryEmail: boolean;
      role?: string;
      companyId?: string;
      companyName?: string;
      accessCode?: string;
      isCompanyCreator?: boolean;
      needsAccessCodeSetup?: boolean;
    }
  | { ok: false; message: string }
> {
  if (!isPortalAuthConfigured()) {
    // Fallback to direct profiles read when web API is not configured.
    if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
    const sess = await supabase.auth.getSession();
    if (!sess.data.session) return { ok: false, message: 'Sign in required.' };
    const result = await supabase
      .from('profiles')
      .select('login_name, display_name, recovery_email, recovery_email_norm, role, company_id')
      .eq('id', sess.data.session.user.id)
      .maybeSingle();
    if (result.error || !result.data) {
      return { ok: false, message: result.error?.message || 'Could not load account.' };
    }
    const row = result.data;
    return {
      ok: true,
      loginName: row.login_name || row.display_name || '',
      recoveryEmail: row.recovery_email || '',
      hasRecoveryEmail: !!row.recovery_email_norm,
      role: row.role || '',
      companyId: row.company_id || '',
    };
  }
  const r = await portalAuthedFetch<{
    loginName?: string;
    recoveryEmail?: string;
    hasRecoveryEmail?: boolean;
    role?: string;
    companyId?: string;
    companyName?: string;
    accessCode?: string;
    isCompanyCreator?: boolean;
    needsAccessCodeSetup?: boolean;
  }>('GET', '/api/portal/account');
  if (!r.ok) return r;
  return {
    ok: true,
    loginName: r.loginName || '',
    recoveryEmail: r.recoveryEmail || '',
    hasRecoveryEmail: !!r.hasRecoveryEmail,
    role: r.role || '',
    companyId: r.companyId || '',
    companyName: r.companyName || '',
    accessCode: r.accessCode || '',
    isCompanyCreator: !!r.isCompanyCreator,
    needsAccessCodeSetup: !!r.needsAccessCodeSetup,
  };
}

async function portalAuthedFetch<T extends Record<string, unknown>>(
  method: string,
  path: string,
  body?: Record<string, unknown>
): Promise<PortalOk<T> | PortalErr> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sess = await supabase.auth.getSession();
  if (!sess.data.session?.access_token) {
    return { ok: false, message: 'Sign in required.' };
  }
  const base = portalApiBase();
  if (!base) {
    return {
      ok: false,
      message:
        'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server, then restart Expo.',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);
  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sess.data.session.access_token}`,
      },
      signal: controller.signal,
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(`${base}${path}`, opts);
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !data.ok) {
      const raw = (data.message as string) || 'Request failed.';
      let msg = friendlyPortalErrorMessage(raw);
      if (res.status === 401 && (data.needsSignIn || isInvalidAuthTokenError(raw))) {
        await clearLocalAuthSession();
        msg = friendlyAuthTokenMessage(raw, 'session');
      }
      return {
        ok: false,
        message: msg,
        needsSignIn: !!data.needsSignIn || isInvalidAuthTokenError(raw),
        status: res.status,
      };
    }
    return { ok: true, ...(data as T) };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ok: false, message: 'Request timed out.' };
    }
    return { ok: false, message: 'Could not reach the web server.' };
  } finally {
    clearTimeout(timeout);
  }
}

export type PortalCreateEmployeePayload = {
  loginName: string;
  password: string;
  displayName: string;
  phone?: string;
  staffType?: string;
  recoveryEmail?: string;
  role?: 'employee' | 'manager';
};

/** Manager-only: create portal login for a new employee/manager without changing the current session. */
export async function portalCreateEmployeeAccount(
  payload: PortalCreateEmployeePayload
): Promise<
  | {
      ok: true;
      userId?: string;
      loginName?: string;
      displayName?: string;
      role?: string;
      message?: string;
    }
  | { ok: false; message: string }
> {
  if (!isPortalAuthConfigured()) {
    return { ok: false, message: 'Portal auth is not configured (EXPO_PUBLIC_GM_WEB_URL).' };
  }
  const r = await portalAuthedFetch<{
    userId?: string;
    loginName?: string;
    displayName?: string;
    role?: string;
    message?: string;
  }>('POST', '/api/portal/admin/create-employee', payload as unknown as Record<string, unknown>);
  if (!r.ok) return r;
  return {
    ok: true,
    userId: r.userId,
    loginName: r.loginName,
    displayName: r.displayName,
    role: r.role,
    message: r.message || 'Portal account created.',
  };
}

export async function portalUpdateRecoveryEmail(
  recoveryEmail: string
): Promise<{ ok: true; recoveryEmail: string; message: string } | { ok: false; message: string }> {
  if (!supabase) return { ok: false, message: 'Supabase is not configured.' };
  const sess = await supabase.auth.getSession();
  if (!sess.data.session) return { ok: false, message: 'Sign in required.' };
  const norm = String(recoveryEmail || '')
    .trim()
    .toLowerCase();
  if (!norm) return { ok: false, message: 'Enter your recovery email.' };
  if (!isValidRecoveryEmail(norm)) {
    return { ok: false, message: 'Enter a valid email address.' };
  }
  if (isPortalAuthConfigured()) {
    const viaApi = await portalAuthedFetch<{ recoveryEmail?: string; message?: string }>(
      'PUT',
      '/api/portal/account/recovery-email',
      { recoveryEmail: norm }
    );
    if (viaApi.ok) {
      return {
        ok: true,
        recoveryEmail: viaApi.recoveryEmail || norm,
        message: viaApi.message || 'Recovery email saved. Your sign-in name was not changed.',
      };
    }
  }
  const dup = await supabase
    .from('profiles')
    .select('id')
    .eq('recovery_email_norm', norm)
    .neq('id', sess.data.session.user.id)
    .limit(1);
  if (dup.error) return { ok: false, message: dup.error.message || 'Could not save.' };
  if (dup.data && dup.data.length) {
    return { ok: false, message: 'That email is already used on another account.' };
  }
  const saved = await supabase
    .from('profiles')
    .update({ recovery_email: norm, recovery_email_norm: norm })
    .eq('id', sess.data.session.user.id);
  if (saved.error) {
    if (saved.error.code === '23505') {
      return { ok: false, message: 'That email is already used on another account.' };
    }
    return { ok: false, message: saved.error.message || 'Could not save recovery email.' };
  }
  return {
    ok: true,
    recoveryEmail: norm,
    message: 'Recovery email saved. Your sign-in name was not changed.',
  };
}

export async function portalUpdateLoginName(
  loginName: string
): Promise<{ ok: true; loginName: string; message: string } | { ok: false; message: string }> {
  const next = String(loginName || '').trim();
  if (!next) return { ok: false, message: 'Enter a sign-in username.' };
  if (next.length > 80) return { ok: false, message: 'Username must be 80 characters or fewer.' };
  if (/@/.test(next)) {
    return { ok: false, message: 'Use a username, not an email address, for sign-in.' };
  }
  if (!isPortalAuthConfigured()) {
    return {
      ok: false,
      message: 'Set EXPO_PUBLIC_GM_WEB_URL to your web server to change username.',
    };
  }
  const r = await portalAuthedFetch<{ loginName?: string; message?: string }>(
    'PUT',
    '/api/portal/account/login-name',
    { loginName: next }
  );
  if (!r.ok) return r;
  return {
    ok: true,
    loginName: r.loginName || next,
    message: r.message || 'Sign-in username updated. Your display name was not changed.',
  };
}

/** Permanently delete the signed-in account. Requires typing DELETE. */
export async function portalDeleteAccount(
  confirmText: string
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const confirm = String(confirmText || '')
    .trim()
    .toUpperCase();
  if (confirm !== 'DELETE') {
    return { ok: false, message: 'Type DELETE to permanently delete your account.' };
  }
  if (!isPortalAuthConfigured()) {
    return {
      ok: false,
      message: 'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server, then restart Expo.',
    };
  }
  const r = await portalAuthedFetch<{ message?: string }>('POST', '/api/portal/account/delete', {
    confirm: 'DELETE',
  });
  if (!r.ok) return r;
  return {
    ok: true,
    message: r.message || 'Your account has been permanently deleted.',
  };
}

export async function portalRegisterPushToken(payload: {
  expoPushToken: string;
  teamStateId?: string;
  platform?: string;
}): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isPortalAuthConfigured()) {
    return { ok: false, message: 'Portal auth is not configured (EXPO_PUBLIC_GM_WEB_URL).' };
  }
  const r = await portalAuthedFetch('POST', '/api/portal/push/register', {
    expoPushToken: payload.expoPushToken,
    teamStateId: payload.teamStateId || '',
    platform: payload.platform || '',
  });
  if (!r.ok) return r;
  return { ok: true };
}

export async function portalNotifySchedulePublished(payload: {
  weekMondayIso: string;
  teamStateId?: string;
}): Promise<{ ok: true; sent: number } | { ok: false; message: string }> {
  if (!isPortalAuthConfigured()) {
    return { ok: false, message: 'Portal auth is not configured (EXPO_PUBLIC_GM_WEB_URL).' };
  }
  const r = await portalAuthedFetch<{ sent?: number }>('POST', '/api/portal/schedule/notify-published', {
    weekMondayIso: payload.weekMondayIso,
    teamStateId: payload.teamStateId || '',
  });
  if (!r.ok) return r;
  return { ok: true, sent: r.sent != null ? Number(r.sent) : 0 };
}
