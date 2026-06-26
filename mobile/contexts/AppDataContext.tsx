import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { hydrateFromSupabase, type HydrationResult } from '../lib/hydrate';
import type { AssignmentStore } from '../lib/schedule/types';
import { subscribeEmployees } from '../lib/employeesSync';
import { subscribeStaffRequests } from '../lib/staffRequestsSync';
import { subscribeTeamState } from '../lib/teamStateSync';
import { applyTipPayrollFromTeamState, loadDishwasherTipsStore, loadTipPoolStore, loadWeekExtrasStore, queueTipPayrollPushToSupabase } from '../lib/timecards/tipPayrollSync';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { employeeDisplayName, type EmployeeRow } from '../lib/employees';
import { useAuth } from './AuthContext';

type AppDataState = HydrationResult & {
  loading: boolean;
  error: string | null;
  refetch: (opts?: { silent?: boolean }) => Promise<void>;
  /** Optimistic schedule assignment patch for timecards before cloud refetch completes. */
  applyLocalScheduleAssignments: (assignments: AssignmentStore) => void;
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
  const hydratedRef = useRef(false);
  const refetchInFlightRef = useRef(false);
  const refetchAgainRef = useRef(false);
  const silentRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appActiveRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tipPayrollHydratePushRef = useRef(false);

  const runRefetch = useCallback(
    async (opts?: { showLoading?: boolean }) => {
      if (!isSupabaseConfigured || !supabase || !session?.user) {
        hydratedRef.current = false;
        tipPayrollHydratePushRef.current = false;
        setEmployees([]);
        setStaffRequests([]);
        setTeamState(null);
        setLoading(false);
        return;
      }
      if (refetchInFlightRef.current) {
        refetchAgainRef.current = true;
        return;
      }
      const showLoading = opts?.showLoading ?? !hydratedRef.current;
      refetchInFlightRef.current = true;
      if (showLoading) setLoading(true);
      setError(null);
      try {
        const data = await hydrateFromSupabase(supabase, {
          role,
          userId: session.user.id,
        });
        if (data.teamState) {
          await applyTipPayrollFromTeamState(data.teamState);
          if (role === 'manager' && !tipPayrollHydratePushRef.current) {
            const remoteTip = data.teamState.timecard_week_tip_pool;
            const remoteDw = data.teamState.timecard_dishwasher_tips;
            const remoteExtras = data.teamState.timecard_week_extras;
            const remoteTipEmpty =
              !remoteTip || typeof remoteTip !== 'object' || !Object.keys(remoteTip as object).length;
            const remoteDwEmpty =
              !remoteDw || typeof remoteDw !== 'object' || !Object.keys(remoteDw as object).length;
            const remoteExtrasEmpty =
              !remoteExtras ||
              typeof remoteExtras !== 'object' ||
              !Object.keys(remoteExtras as object).length;
            if (remoteTipEmpty || remoteDwEmpty || remoteExtrasEmpty) {
              const [localTip, localDw, localExtras] = await Promise.all([
                loadTipPoolStore(),
                loadDishwasherTipsStore(),
                loadWeekExtrasStore(),
              ]);
              if (
                (remoteTipEmpty && Object.keys(localTip).length) ||
                (remoteDwEmpty && Object.keys(localDw).length) ||
                (remoteExtrasEmpty && Object.keys(localExtras).length)
              ) {
                tipPayrollHydratePushRef.current = true;
                queueTipPayrollPushToSupabase(supabase);
              }
            }
          }
        }
        setEmployees(data.employees);
        setStaffRequests(data.staffRequests);
        setTeamState(data.teamState);
        hydratedRef.current = true;
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load data');
      } finally {
        refetchInFlightRef.current = false;
        setLoading(false);
        if (refetchAgainRef.current) {
          refetchAgainRef.current = false;
          void runRefetch({ showLoading: false });
        }
      }
    },
    [session?.user?.id, role]
  );

  const refetch = useCallback(async (opts?: { silent?: boolean }) => {
    await runRefetch({ showLoading: !opts?.silent });
  }, [runRefetch]);

  const applyLocalScheduleAssignments = useCallback((assignments: AssignmentStore) => {
    setTeamState((prev: HydrationResult['teamState']) => {
      if (!prev) return prev;
      return {
        ...prev,
        schedule_assignments: JSON.parse(JSON.stringify(assignments)),
        updated_at: new Date().toISOString(),
      };
    });
  }, []);

  const scheduleSilentRefetch = useCallback(() => {
    if (silentRefetchTimerRef.current) clearTimeout(silentRefetchTimerRef.current);
    silentRefetchTimerRef.current = setTimeout(() => {
      silentRefetchTimerRef.current = null;
      void runRefetch({ showLoading: false });
    }, 400);
  }, [runRefetch]);

  useEffect(() => {
    hydratedRef.current = false;
    tipPayrollHydratePushRef.current = false;
    void runRefetch();
  }, [runRefetch, role, session?.user?.id]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    return subscribeEmployees(supabase, scheduleSilentRefetch);
  }, [session?.user?.id, scheduleSilentRefetch]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    return subscribeTeamState(supabase, scheduleSilentRefetch);
  }, [session?.user?.id, scheduleSilentRefetch]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    return subscribeStaffRequests(supabase, scheduleSilentRefetch);
  }, [session?.user?.id, scheduleSilentRefetch]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    const onAppState = (state: AppStateStatus) => {
      if (state !== 'active') return;
      if (appActiveRefetchTimerRef.current) clearTimeout(appActiveRefetchTimerRef.current);
      appActiveRefetchTimerRef.current = setTimeout(() => {
        appActiveRefetchTimerRef.current = null;
        void runRefetch({ showLoading: false });
      }, 500);
    };
    const sub = AppState.addEventListener('change', onAppState);
    return () => {
      if (appActiveRefetchTimerRef.current) clearTimeout(appActiveRefetchTimerRef.current);
      sub.remove();
    };
  }, [session?.user?.id, runRefetch]);

  useEffect(
    () => () => {
      if (silentRefetchTimerRef.current) clearTimeout(silentRefetchTimerRef.current);
      if (appActiveRefetchTimerRef.current) clearTimeout(appActiveRefetchTimerRef.current);
    },
    []
  );

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
      applyLocalScheduleAssignments,
      myEmployee,
    }),
    [employees, staffRequests, teamState, loading, error, refetch, applyLocalScheduleAssignments, myEmployee]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataState {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
