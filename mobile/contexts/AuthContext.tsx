import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { isPortalAuthConfigured, portalSignIn } from '../lib/portalAuth';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

export type AppRole = 'manager' | 'employee';

type AuthState = {
  session: Session | null;
  user: User | null;
  role: AppRole | null;
  displayName: string;
  loading: boolean;
  signIn: (loginName: string, password: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<AppRole | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [loading, setLoading] = useState(true);

  const applySession = useCallback(async (sess: Session | null) => {
    setSession(sess);
    setUser(sess?.user ?? null);
    if (!sess?.user || !supabase) {
      setRole(null);
      setDisplayName('');
      return;
    }
    const prof = await supabase
      .from('profiles')
      .select('role, display_name')
      .eq('id', sess.user.id)
      .maybeSingle();
    if (prof.error || !prof.data) {
      await supabase.auth.signOut();
      setRole(null);
      setDisplayName('');
      return;
    }
    const r = prof.data.role as string;
    if (r !== 'manager' && r !== 'employee') {
      await supabase.auth.signOut();
      setRole(null);
      setDisplayName('');
      return;
    }
    setRole(r);
    setDisplayName(String(prof.data.display_name || '').trim());
  }, []);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getSession();
      if (!cancelled) await applySession(data.session ?? null);
      if (!cancelled) setLoading(false);
    })();
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      void applySession(sess);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, [applySession]);

  const signIn = useCallback(
    async (loginName: string, password: string) => {
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
      const portal = await portalSignIn(loginName, password);
      if (!portal.ok) return portal;
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        return { ok: false as const, message: 'Sign in failed.' };
      }
      const prof = await supabase
        .from('profiles')
        .select('role, display_name')
        .eq('id', data.session.user.id)
        .maybeSingle();
      if (prof.error || !prof.data) {
        await supabase.auth.signOut();
        return {
          ok: false as const,
          message:
            prof.error?.message || 'No profile row for this user. Run migrations and try again.',
        };
      }
      const r = prof.data.role as string;
      if (r !== 'manager' && r !== 'employee') {
        await supabase.auth.signOut();
        return {
          ok: false as const,
          message: 'This account is not a manager or employee app login.',
        };
      }
      await applySession(data.session);
      return { ok: true as const };
    },
    [applySession]
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
      signOut,
    }),
    [session, user, role, displayName, loading, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
