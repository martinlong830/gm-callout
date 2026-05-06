import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { hydrateFromSupabase, type HydrationResult } from '../lib/hydrate';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { employeeDisplayName, type EmployeeRow } from '../lib/employees';
import { useAuth } from './AuthContext';

type AppDataState = HydrationResult & {
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** Logged-in employee roster row (by auth link or display name). */
  myEmployee: EmployeeRow | null;
};

const AppDataContext = createContext<AppDataState | null>(null);

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { session, displayName, role } = useAuth();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [staffRequests, setStaffRequests] = useState<HydrationResult['staffRequests']>([]);
  const [teamState, setTeamState] = useState<HydrationResult['teamState']>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !session?.user) {
      setEmployees([]);
      setStaffRequests([]);
      setTeamState(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await hydrateFromSupabase(supabase);
      setEmployees(data.employees);
      setStaffRequests(data.staffRequests);
      setTeamState(data.teamState);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    void refetch();
  }, [refetch, role, session?.user?.id]);

  const myEmployee = useMemo(() => {
    if (!session?.user?.id || role !== 'employee') return null;
    const uid = session.user.id;
    const byAuth = employees.find((e) => e.authUserId === uid);
    if (byAuth) return byAuth;
    const dn = displayName.trim();
    if (!dn) return null;
    return (
      employees.find(
        (e) => employeeDisplayName(e).toLowerCase() === dn.toLowerCase()
      ) ?? null
    );
  }, [employees, displayName, role, session?.user?.id]);

  const value = useMemo(
    () => ({
      employees,
      staffRequests,
      teamState,
      loading,
      error,
      refetch,
      myEmployee,
    }),
    [employees, staffRequests, teamState, loading, error, refetch, myEmployee]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataState {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
