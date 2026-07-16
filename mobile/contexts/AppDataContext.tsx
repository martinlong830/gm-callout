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
import {
  fetchEmployeesOnly,
  fetchStaffRequestsOnly,
  hydrateFromSupabase,
  type HydrationResult,
} from '../lib/hydrate';
import type { AssignmentStore } from '../lib/schedule/types';
import { subscribeEmployees } from '../lib/employeesSync';
import { subscribeStaffRequests } from '../lib/staffRequestsSync';
import { readStoredTeamStateId } from '../lib/companySession';
import { subscribeTeamState } from '../lib/teamStateSync';
import {
  applyTipPayrollFromTeamState,
} from '../lib/timecards/tipPayrollSync';
import {
  fetchTeamStateColumns,
  fetchTeamStateUpdatedAt,
  mergeTeamStatePartial,
} from '../lib/teamStateColumns';
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

/** Skip foreground REST when we hydrated recently and updated_at is unchanged. */
const FOREGROUND_SKIP_IF_FRESH_MS = 90_000;

export function AppDataProvider({ children }: { children: React.ReactNode }) {
  const { session, displayName, role } = useAuth();
  const [employees, setEmployees] = useState<EmployeeRow[]>([]);
  const [staffRequests, setStaffRequests] = useState<HydrationResult['staffRequests']>([]);
  const [teamState, setTeamState] = useState<HydrationResult['teamState']>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [realtimePaused, setRealtimePaused] = useState(
    () => AppState.currentState !== 'active'
  );
  const hydratedRef = useRef(false);
  const refetchInFlightRef = useRef(false);
  const refetchAgainRef = useRef(false);
  const silentRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appActiveRefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const teamStateRef = useRef<HydrationResult['teamState']>(null);
  const lastHydrateAtRef = useRef(0);
  const teamStateFieldsPendingRef = useRef<Set<string> | null>(null);

  teamStateRef.current = teamState;

  const runRefetch = useCallback(
    async (opts?: { showLoading?: boolean }) => {
      if (!isSupabaseConfigured || !supabase || !session?.user) {
        hydratedRef.current = false;
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
          // Apply remote tip/VL as SoT; do not push local AsyncStorage when remote is empty —
          // that resurrected per-device caches onto shared team_state for other managers.
          await applyTipPayrollFromTeamState(data.teamState);
        }
        setEmployees(data.employees);
        setStaffRequests(data.staffRequests);
        setTeamState(data.teamState);
        hydratedRef.current = true;
        lastHydrateAtRef.current = Date.now();
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

  const refreshTeamStateSelective = useCallback(
    async (fields?: string[]) => {
      if (!isSupabaseConfigured || !supabase || !session?.user) return;
      const known = teamStateRef.current?.updated_at
        ? String(teamStateRef.current.updated_at)
        : null;
      if (known) {
        const remoteAt = await fetchTeamStateUpdatedAt(supabase);
        if (remoteAt && remoteAt === known) return;
      }
      const partial = await fetchTeamStateColumns(supabase, { role, fields });
      if (!partial) return;
      await applyTipPayrollFromTeamState(partial);
      setTeamState((prev) => mergeTeamStatePartial(prev, partial));
      lastHydrateAtRef.current = Date.now();
    },
    [session?.user?.id, role]
  );

  const scheduleTeamStateRemoteRefresh = useCallback(
    (fields?: string[]) => {
      if (fields?.length) {
        if (!teamStateFieldsPendingRef.current) {
          teamStateFieldsPendingRef.current = new Set();
        }
        fields.forEach((f) => teamStateFieldsPendingRef.current!.add(f));
      } else {
        teamStateFieldsPendingRef.current = null;
      }
      if (silentRefetchTimerRef.current) clearTimeout(silentRefetchTimerRef.current);
      silentRefetchTimerRef.current = setTimeout(() => {
        silentRefetchTimerRef.current = null;
        const pending = teamStateFieldsPendingRef.current;
        teamStateFieldsPendingRef.current = null;
        void refreshTeamStateSelective(pending ? Array.from(pending) : undefined);
      }, 400);
    },
    [refreshTeamStateSelective]
  );

  const refreshEmployeesOnly = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    try {
      const list = await fetchEmployeesOnly(supabase, {
        role,
        userId: session.user.id,
      });
      setEmployees(list);
    } catch (e) {
      console.warn('employees selective refresh', e);
    }
  }, [session?.user?.id, role]);

  const refreshStaffRequestsOnly = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    try {
      const list = await fetchStaffRequestsOnly(supabase);
      setStaffRequests(list);
    } catch (e) {
      console.warn('staff_requests selective refresh', e);
    }
  }, [session?.user?.id]);

  useEffect(() => {
    hydratedRef.current = false;
    void runRefetch();
  }, [runRefetch, role, session?.user?.id]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user || role !== 'manager') return;
    if (realtimePaused) return;
    return subscribeEmployees(supabase, () => {
      void refreshEmployeesOnly();
    });
  }, [session?.user?.id, role, realtimePaused, refreshEmployeesOnly]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    if (realtimePaused) return;
    let cancelled = false;
    let unsub: (() => void) | undefined;
    void (async () => {
      const teamStateId = await readStoredTeamStateId();
      if (cancelled) return;
      unsub = subscribeTeamState(supabase, teamStateId, (fields) => {
        scheduleTeamStateRemoteRefresh(fields);
      });
    })();
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [session?.user?.id, realtimePaused, scheduleTeamStateRemoteRefresh]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    if (realtimePaused) return;
    return subscribeStaffRequests(supabase, () => {
      void refreshStaffRequestsOnly();
    });
  }, [session?.user?.id, realtimePaused, refreshStaffRequestsOnly]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase || !session?.user) return;
    const onAppState = (state: AppStateStatus) => {
      if (state !== 'active') {
        setRealtimePaused(true);
        return;
      }
      setRealtimePaused(false);
      if (appActiveRefetchTimerRef.current) clearTimeout(appActiveRefetchTimerRef.current);
      appActiveRefetchTimerRef.current = setTimeout(() => {
        appActiveRefetchTimerRef.current = null;
        void (async () => {
          const age = Date.now() - lastHydrateAtRef.current;
          if (hydratedRef.current && age < FOREGROUND_SKIP_IF_FRESH_MS) {
            const known = teamStateRef.current?.updated_at
              ? String(teamStateRef.current.updated_at)
              : null;
            if (known) {
              const remoteAt = await fetchTeamStateUpdatedAt(supabase!);
              if (remoteAt && remoteAt === known) return;
              // team_state changed while still relatively fresh — refresh it without
              // also pulling full roster/requests unless the hydrate is older.
              await refreshTeamStateSelective();
              if (age < FOREGROUND_SKIP_IF_FRESH_MS / 2) return;
              await Promise.all([refreshEmployeesOnly(), refreshStaffRequestsOnly()]);
              return;
            }
            // Hydrated recently but no updated_at to probe — skip noisy trio.
            return;
          }
          // Prefer selective team_state + light roster/request refresh over full hydrate.
          await Promise.all([
            refreshTeamStateSelective(),
            refreshEmployeesOnly(),
            refreshStaffRequestsOnly(),
          ]);
        })();
      }, 800);
    };
    const sub = AppState.addEventListener('change', onAppState);
    return () => {
      if (appActiveRefetchTimerRef.current) clearTimeout(appActiveRefetchTimerRef.current);
      sub.remove();
    };
  }, [
    session?.user?.id,
    refreshTeamStateSelective,
    refreshEmployeesOnly,
    refreshStaffRequestsOnly,
  ]);

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
