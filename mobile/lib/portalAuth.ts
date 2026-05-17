import { supabase } from './supabase';

function portalApiBase(): string {
  const raw = process.env.EXPO_PUBLIC_GM_WEB_URL ?? '';
  return String(raw).trim().replace(/\/$/, '');
}

export function isPortalAuthConfigured(): boolean {
  return !!portalApiBase();
}

export async function portalSignIn(
  loginName: string,
  password: string
): Promise<{ ok: true } | { ok: false; message: string }> {
  const base = portalApiBase();
  if (!base) {
    return {
      ok: false,
      message:
        'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server (e.g. http://192.168.1.10:8000), then restart Expo.',
    };
  }
  if (!supabase) {
    return { ok: false, message: 'Supabase is not configured.' };
  }
  let data: {
    ok?: boolean;
    message?: string;
    access_token?: string;
    refresh_token?: string;
  } = {};
  try {
    const res = await fetch(`${base}/api/portal/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: loginName.trim(), password }),
    });
    data = await res.json();
    if (!res.ok || !data.ok || !data.access_token) {
      return { ok: false, message: data.message || 'Sign in failed.' };
    }
  } catch {
    return {
      ok: false,
      message: 'Could not reach the web server. Check EXPO_PUBLIC_GM_WEB_URL and that npm start is running.',
    };
  }
  const { error } = await supabase.auth.setSession({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? '',
  });
  if (error) {
    return { ok: false, message: error.message || 'Could not start session.' };
  }
  return { ok: true };
}
