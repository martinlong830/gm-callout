import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { loadWeekEntries } from '../lib/timecards/entriesApi';
import {
  buildPayWeekOptions,
  formatPayWeekLabel,
  getSelectedPayWeekMondayDate,
  isoFromDate,
  payWeekBoundsFromMonday,
  saveSelectedPayWeekStartIso,
  weekBoundsStorageKey,
  type PayWeekOption,
} from '../lib/timecards/payWeek';
import type { PayWeekBounds, TimecardSchema, TimeClockEntry } from '../lib/timecards/types';
import { subscribeTimeClockEntries } from '../lib/timeClockEntriesSync';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type CachedWeekEntries = {
  entries: TimeClockEntry[];
  schema: TimecardSchema;
};

type TimecardsState = {
  entries: TimeClockEntry[];
  schema: TimecardSchema;
  loading: boolean;
  error: string | null;
  bounds: PayWeekBounds;
  weekLabel: string;
  payWeekOptions: PayWeekOption[];
  selectedWeekStartIso: string;
  setPayWeekStartIso: (startIso: string) => void;
  refresh: () => Promise<void>;
};

const TimecardsContext = createContext<TimecardsState | null>(null);

export function TimecardsProvider({ children }: { children: React.ReactNode }) {
  const payWeekOptions = useMemo(() => buildPayWeekOptions(), []);
  const [ready, setReady] = useState(false);
  const [selectedWeekStartIso, setSelectedWeekStartIso] = useState('');
  const [bounds, setBounds] = useState<PayWeekBounds>(() =>
    payWeekBoundsFromMonday(new Date())
  );
  const [entries, setEntries] = useState<TimeClockEntry[]>([]);
  const [schema, setSchema] = useState<TimecardSchema>({
    breakMinutes: false,
    breakTimes: false,
    scheduleShiftId: false,
    editHistory: false,
    breakPaid: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const refetchInFlightRef = useRef(false);
  const refetchAgainRef = useRef(false);
  const entriesCacheRef = useRef<Map<string, CachedWeekEntries>>(new Map());
  const runRefreshRef = useRef<(opts?: { showLoading?: boolean; force?: boolean }) => Promise<void>>(
    async () => {}
  );

  useEffect(() => {
    (async () => {
      const mon = await getSelectedPayWeekMondayDate();
      const iso = isoFromDate(mon);
      setSelectedWeekStartIso(iso);
      setBounds(payWeekBoundsFromMonday(mon));
      setReady(true);
    })();
  }, []);

  const weekLabel = useMemo(() => formatPayWeekLabel(bounds), [bounds]);

  const runRefresh = useCallback(
    async (opts?: { showLoading?: boolean; force?: boolean }) => {
      if (!isSupabaseConfigured || !supabase) {
        hydratedRef.current = false;
        setEntries([]);
        setError('Supabase is not configured.');
        setLoading(false);
        return;
      }
      if (refetchInFlightRef.current) {
        refetchAgainRef.current = true;
        return;
      }

      const weekKey = weekBoundsStorageKey(bounds);
      const cached = !opts?.force ? entriesCacheRef.current.get(weekKey) : undefined;
      const hasCache = !!cached;
      const showLoading = opts?.showLoading ?? !hasCache;

      refetchInFlightRef.current = true;
      if (hasCache) {
        setEntries(cached.entries);
        setSchema(cached.schema);
        setError(null);
        hydratedRef.current = true;
      } else if (!opts?.force) {
        setEntries([]);
      }
      if (showLoading) setLoading(true);
      else if (hasCache) setLoading(false);
      if (!hasCache) setError(null);

      try {
        const res = await loadWeekEntries(supabase, bounds);
        if (!res.ok) {
          if (!hasCache) {
            setError(res.reason);
            setEntries([]);
          }
        } else {
          entriesCacheRef.current.set(weekKey, {
            entries: res.entries,
            schema: res.schema,
          });
          setEntries(res.entries);
          setSchema(res.schema);
          setError(null);
          hydratedRef.current = true;
        }
      } finally {
        refetchInFlightRef.current = false;
        setLoading(false);
        if (refetchAgainRef.current) {
          refetchAgainRef.current = false;
          void runRefresh({ showLoading: false, force: true });
        }
      }
    },
    [bounds]
  );

  const refresh = useCallback(async () => {
    await runRefresh({ showLoading: true, force: true });
  }, [runRefresh]);

  runRefreshRef.current = runRefresh;

  useEffect(() => {
    if (ready) void runRefresh();
  }, [ready, bounds, runRefresh]);

  useEffect(() => {
    if (!isSupabaseConfigured || !supabase) return;
    return subscribeTimeClockEntries(supabase, () => {
      entriesCacheRef.current.delete(weekBoundsStorageKey(bounds));
      void runRefreshRef.current({ showLoading: false, force: true });
    });
  }, [bounds]);

  const setPayWeekStartIso = useCallback((startIso: string) => {
    void saveSelectedPayWeekStartIso(startIso);
    setSelectedWeekStartIso(startIso);
    const mon = new Date(`${startIso}T12:00:00`);
    setBounds(payWeekBoundsFromMonday(mon));
  }, []);

  const value = useMemo(
    () => ({
      entries,
      schema,
      loading: !ready || (loading && !hydratedRef.current),
      error,
      bounds,
      weekLabel,
      payWeekOptions,
      selectedWeekStartIso,
      setPayWeekStartIso,
      refresh,
    }),
    [
      entries,
      schema,
      ready,
      loading,
      error,
      bounds,
      weekLabel,
      payWeekOptions,
      selectedWeekStartIso,
      setPayWeekStartIso,
      refresh,
    ]
  );

  return <TimecardsContext.Provider value={value}>{children}</TimecardsContext.Provider>;
}

export function useTimecards(): TimecardsState {
  const ctx = useContext(TimecardsContext);
  if (!ctx) throw new Error('useTimecards must be used within TimecardsProvider');
  return ctx;
}
