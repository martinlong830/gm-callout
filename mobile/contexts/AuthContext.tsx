import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import {
  clearLocalAuthSession,
  isPortalAuthConfigured,
  portalSignIn,
  portalSignUp,
  type PortalSignUpPayload,
} from '../lib/portalAuth';
import { isInvalidAuthTokenError } from '../lib/authErrors';
import { createEmployeeRosterRow, type RegisterEmployeeInput } from '../lib/registerEmployee';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export type AppRole = 'manager' | 'employee';

type AuthState = {
  session: Session | null;
  user: User | null;
  role: AppRole | null;
  displayName: string;
  loading: boolean;
  signIn: (
    loginName: string,
    password: string,
    companyId?: string,
    accessCode?: string
  ) => Promise<{ ok: true; role: AppRole } | { ok: false; message: string }>;
  signUp: (
    payload: PortalSignUpPayload,
    roster?: RegisterEmployeeInput
  ) => Promise<
    | { ok: true; needsSignIn?: boolean; message?: string }
    | { ok: false; message: string }
  >;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

function isAppRole(r: string | undefined): r is AppRole {
  return r === 'manager' || r === 'employee';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);
  const signInInFlightRef = useRef(false);

  const applyProfile = useCallback((sess: Session, r: AppRole, name: string) => {
    setSession(sess);
    setUser(sess.user);
    setRole(r);
    setDisplayName(name);
  }, []);

  const fetchProfile = useCallback(async (userId: string) => {
    if (!supabase) return null;
    const prof = await supabase
      .from('profiles')
      .select('role, display_name')
      .eq('id', userId)
      .maybeSingle();
    if (prof.error) {
      if (isInvalidAuthTokenError(prof.error.message)) {
        return { invalidToken: true as const };
      }
      return null;
    }
    if (!prof.data) return null;
    const r = prof.data.role as string;
    if (!isAppRole(r)) return null;
    return { role: r, displayName: String(prof.data.display_name || '').trim() };
  }, []);

  const applySession = useCallback(
    async (sess: Session | null) => {
      if (!sess?.user || !supabase) {
        setSession(null);
        setUser(null);
        setRole(null);
        setDisplayName('');
        return;
      }
      const prof = await fetchProfile(sess.user.id);
      if (!prof || 'invalidToken' in prof) {
        await clearLocalAuthSession();
        setSession(null);
        setUser(null);
        setRole(null);
        setDisplayName('');
        return;
      }
      applyProfile(sess, prof.role, prof.displayName);
    },
    [applyProfile, fetchProfile]
  );

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.auth.getSession();
      if (cancelled) return;
      if (error && isInvalidAuthTokenError(error.message)) {
        await clearLocalAuthSession();
        await applySession(null);
        if (!cancelled) setLoading(false);
        return;
      }
      const sess = data.session ?? null;
      if (sess) {
        // Validate with Auth server so a stale refresh token cannot linger.
        const { error: userErr } = await supabase.auth.getUser();
        if (cancelled) return;
        if (userErr && isInvalidAuthTokenError(userErr.message)) {
          await clearLocalAuthSession();
          await applySession(null);
          if (!cancelled) setLoading(false);
          return;
        }
      }
      if (!cancelled) await applySession(sess);
      if (!cancelled) setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((event, sess) => {
      if (signInInFlightRef.current) return;
      if (event === 'TOKEN_REFRESHED' && !sess) {
        void clearLocalAuthSession().then(() => applySession(null));
        return;
      }
      void applySession(sess);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [applySession]);

  const signIn = useCallback(
    async (loginName: string, password: string, companyId?: string, accessCode?: string) => {
      if (!supabase) {
        return { ok: false as const, message: 'Supabase is not configured.' };
      }
      if (!isPortalAuthConfigured()) {
        return {
          ok: false as const,
          message:
            'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server URL, then restart Expo.',
        };
      }
      signInInFlightRef.current = true;
      try {
        const portal = await portalSignIn(loginName, password, companyId, accessCode);
        if (!portal.ok) return portal;

        const { data } = await supabase.auth.getSession();
        if (!data.session) {
          return { ok: false as const, message: 'Sign in failed.' };
        }

        if (isAppRole(portal.role)) {
          applyProfile(
            data.session,
            portal.role,
            String(portal.displayName || loginName).trim()
          );
          return { ok: true as const, role: portal.role };
        }

        const prof = await fetchProfile(data.session.user.id);
        if (!prof || 'invalidToken' in prof) {
          await clearLocalAuthSession();
          return {
            ok: false as const,
            message:
              prof && 'invalidToken' in prof
                ? 'Your session token is invalid. Sign in again with your name and password.'
                : 'No profile row for this user. Run migrations and try again.',
          };
        }
        applyProfile(data.session, prof.role, prof.displayName);
        return { ok: true as const, role: prof.role };
      } finally {
        signInInFlightRef.current = false;
      }
    },
    [applyProfile, fetchProfile]
  );

  const signUp = useCallback(
    async (payload: PortalSignUpPayload, roster?: RegisterEmployeeInput) => {
      if (!supabase) {
        return { ok: false as const, message: 'Supabase is not configured.' };
      }
      if (!isPortalAuthConfigured()) {
        return {
          ok: false as const,
          message:
            'Set EXPO_PUBLIC_GM_WEB_URL in mobile/.env to your web server URL, then restart Expo.',
        };
      }
      const up = await portalSignUp(payload);
      if (!up.ok) return up;
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        if (up.needsSignIn) {
          return { ok: true as const, needsSignIn: true, message: up.message };
        }
        return { ok: false as const, message: 'Account created but sign-in failed. Try signing in.' };
      }
      if (payload.role === 'employee' && roster) {
        const rosterRes = await createEmployeeRosterRow(supabase, {
          ...roster,
          authUserId: data.session.user.id,
        });
        if (!rosterRes.ok) {
          return {
            ok: false as const,
            message:
              rosterRes.message ||
              'Account was created but roster update failed. Ask a manager for help.',
          };
        }
      }
      if (isAppRole(up.role)) {
        applyProfile(data.session, up.role, String(up.displayName || payload.loginName).trim());
      } else {
        await applySession(data.session);
      }
      return { ok: true as const, needsSignIn: up.needsSignIn, message: up.message };
    },
    [applyProfile, applySession]
  );

  const signOut = useCallback(async () => {
    if (!supabase) return;
    await supabase.auth.signOut();
    await applySession(null);
  }, [applySession]);

  const value = useMemo(
    () => ({
      session,
      user,
      role,
      displayName,
      loading,
      signIn,
      signUp,
      signOut,
    }),
    [session, user, role, displayName, loading, signIn, signUp, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
