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
    data = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !data.ok) {
      let msg = (data.message as string) || 'Request failed.';
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
  const { error } = await supabase.auth.setSession({
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? '',
  });
  if (error) return { ok: false, message: error.message || 'Could not start session.' };
  return { ok: true };
}

export async function portalSignIn(
  loginName: string,
  password: string,
  companyId?: string
): Promise<
  | { ok: true; role?: string; displayName?: string; companyId?: string; companyName?: string }
  | { ok: false; message: string }
> {
  const body: Record<string, unknown> = {
    loginName: loginName.trim(),
    password,
  };
  if (companyId) body.companyId = companyId;
  const r = await portalPost<{
    access_token: string;
    refresh_token?: string;
    role?: string;
    displayName?: string;
    companyId?: string;
    companyName?: string;
  }>('/api/portal/signin', body);
  if (!r.ok) return r;
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
      return {
        ok: false,
        message: (data.message as string) || 'Request failed.',
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
  const dup = await supabase
    .from('profiles')
    .select('id')
    .eq('recovery_email_norm', norm)
    .neq('id', sess.data.session.user.id)
    .maybeSingle();
  if (dup.error) return { ok: false, message: dup.error.message || 'Could not save.' };
  if (dup.data) return { ok: false, message: 'That email is already used on another account.' };
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
