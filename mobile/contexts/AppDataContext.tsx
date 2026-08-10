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
import { subscribeTeamState, TEAM_STATE_SELF_ECHO_IGNORE_MS } from '../lib/teamStateSync';
import {
  applyTipPayrollFromTeamState,
} from '../lib/timecards/tipPayrollSync';
import { applyTipTakehomeFromTeamState } from '../lib/timecards/tipTakehome';
import { invalidateDishwasherTipsSliceCache } from '../lib/timecards/dishwasherTips';
import { invalidateWeekExtrasSliceCache } from '../lib/timecards/weekExtras';
import {
  fetchTeamStateColumns,
  fetchTeamStateUpdatedAt,
  LOCAL_SCHEDULE_DIRTY_KEY,
  mergeTeamStatePartial,
} from '../lib/teamStateColumns';
import { isSupabaseConfigured, supabase } from '../lib/supabase';
import { employeeDisplayName, type EmployeeRow } from '../lib/employees';
import { isManagerLikeRole } from '../lib/roles';
import { useAuth } from './AuthContext';

export type ApplyLocalScheduleOpts = {
  /** `true` = unsaved local edit, `false` = confirmed/remote-sourced, `'keep'` = leave as-is. */
  markDirty?: boolean | 'keep';
  /** `updated_at` returned by the upsert that just stored these assignments. */
  pushedUpdatedAt?: string | null;
};

type AppDataState = HydrationResult & {
  loading: boolean;
  error: string | null;
  refetch: (opts?: { silent?: boolean }) => Promise<void>;
  /** Optimistic schedule assignment patch for timecards before cloud refetch completes. */
  applyLocalScheduleAssignments: (
    assignments: AssignmentStore,
    draftSchedule?: unknown,
    opts?: ApplyLocalScheduleOpts
  ) => void;
  /** Mark a schedule upsert in flight (blocks self-echo refresh). */
  setSchedulePushInFlight: (inFlight: boolean) => void;
  /** Record a successful local schedule push timestamp (self-echo ignore window). */
  noteLocalSchedulePush: () => void;
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
  const lastLocalSchedulePushAtRef = useRef(0);
  const schedulePushInFlightRef = useRef(false);

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
          try {
            await applyTipPayrollFromTeamState(data.teamState);
            await applyTipTakehomeFromTeamState(data.teamState);
            invalidateDishwasherTipsSliceCache();
            invalidateWeekExtrasSliceCache();
          } catch (tipErr) {
            console.warn('applyTipPayrollFromTeamState', tipErr);
          }
        }
        setEmployees(data.employees);
        setStaffRequests(data.staffRequests);
        setTeamState((prev) => {
          const remote = data.teamState;
          if (!remote) return null;
          if (!prev) return remote;
          const protectLocal =
            schedulePushInFlightRef.current ||
            Date.now() - lastLocalSchedulePushAtRef.current < TEAM_STATE_SELF_ECHO_IGNORE_MS ||
            prev[LOCAL_SCHEDULE_DIRTY_KEY] === true;
          return mergeTeamStatePartial(prev, remote as Record<string, unknown>, {
            protectLocalSchedule: protectLocal,
          }) as HydrationResult['teamState'];
        });
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

  const applyLocalScheduleAssignments = useCallback(
    (assignments: AssignmentStore, draftSchedule?: unknown, opts?: ApplyLocalScheduleOpts) => {
      setTeamState((prev: HydrationResult['teamState']) => {
        if (!prev) return prev;
        const markDirty = opts?.markDirty === undefined ? true : opts.markDirty;
        const next: HydrationResult['teamState'] = {
          ...prev,
          schedule_assignments: JSON.parse(JSON.stringify(assignments)),
        };
        if (draftSchedule !== undefined) {
          next.draft_schedule = JSON.parse(JSON.stringify(draftSchedule));
        }
        /*
         * Adopt the upsert's own updated_at. Without it the cache stays on the last snapshot
         * read, every later remote row looks newer, and the freshness probe refetches after
         * every local save — including this device's own broadcast echo.
         */
        if (opts?.pushedUpdatedAt) next.updated_at = String(opts.pushedUpdatedAt);
        if (markDirty === true) {
          /* Dirty flag — not a fake client updated_at — so remote Manager SoT can still win
             after save, while in-flight edits are protected from older REST snapshots. */
          next[LOCAL_SCHEDULE_DIRTY_KEY] = true;
        } else if (markDirty === false) {
          delete next[LOCAL_SCHEDULE_DIRTY_KEY];
        }
        return next;
      });
    },
    []
  );

  const setSchedulePushInFlight = useCallback((inFlight: boolean) => {
    schedulePushInFlightRef.current = inFlight;
  }, []);

  const noteLocalSchedulePush = useCallback(() => {
    lastLocalSchedulePushAtRef.current = Date.now();
  }, []);

  const refreshTeamStateSelective = useCallback(
    async (fields?: string[]) => {
      if (!isSupabaseConfigured || !supabase || !session?.user) return;
      const protectLocal =
        schedulePushInFlightRef.current ||
        Date.now() - lastLocalSchedulePushAtRef.current < TEAM_STATE_SELF_ECHO_IGNORE_MS ||
        teamStateRef.current?.[LOCAL_SCHEDULE_DIRTY_KEY] === true;
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
      await applyTipTakehomeFromTeamState(partial);
      invalidateDishwasherTipsSliceCache();
      invalidateWeekExtrasSliceCache();
      setTeamState((prev) =>
        mergeTeamStatePartial(prev, partial, { protectLocalSchedule: protectLocal })
      );
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
    if (!isSupabaseConfigured || !supabase || !session?.user || !isManagerLikeRole(role)) return;
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
      unsub = subscribeTeamState(supabase, teamStateId, (fields, meta) => {
        const uid = session?.user?.id;
        if (meta?.source && uid && meta.source === uid) {
          /* Own push already applied locally; refreshing the echo can roll edits back. */
          if (schedulePushInFlightRef.current) return;
          if (Date.now() - lastLocalSchedulePushAtRef.current < TEAM_STATE_SELF_ECHO_IGNORE_MS) {
            return;
          }
        }
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
    if (!session?.user?.id || (role !== 'employee' && !isManagerLikeRole(role))) return null;
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
      setSchedulePushInFlight,
      noteLocalSchedulePush,
      myEmployee,
    }),
    [
      employees,
      staffRequests,
      teamState,
      loading,
      error,
      refetch,
      applyLocalScheduleAssignments,
      setSchedulePushInFlight,
      noteLocalSchedulePush,
      myEmployee,
    ]
  );

  return <AppDataContext.Provider value={value}>{children}</AppDataContext.Provider>;
}

export function useAppData(): AppDataState {
  const ctx = useContext(AppDataContext);
  if (!ctx) throw new Error('useAppData must be used within AppDataProvider');
  return ctx;
}
