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
  fetchedAt: number;
  maxUpdatedAt: string | null;
};

/** Skip punch refetch when Realtime fires but week cache is still fresh. */
const WEEK_CACHE_FRESH_MS = 45_000;

type TimecardsState = {
  entries: TimeClockEntry[];
  schema: TimecardSchema;
  loading: boolean;
  /** True when entries + schema match the selected pay week (prevents false zeros). */
  weekReady: boolean;
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
  const [entriesWeekKey, setEntriesWeekKey] = useState<string | null>(null);
  const [schema, setSchema] = useState<TimecardSchema>({
    breakMinutes: false,
    breakTimes: false,
    scheduleShiftId: false,
    editHistory: false,
    breakPaid: false,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshChainRef = useRef(Promise.resolve());
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
  const boundsKey = weekBoundsStorageKey(bounds);

  const runRefresh = useCallback(
    async (opts?: { showLoading?: boolean; force?: boolean }) => {
      if (!isSupabaseConfigured || !supabase) {
        setEntries([]);
        setEntriesWeekKey(null);
        setError('Supabase is not configured.');
        setLoading(false);
        return;
      }
      const sb = supabase;

      const run = async () => {
        const weekKey = weekBoundsStorageKey(bounds);
        const cached = entriesCacheRef.current.get(weekKey);
        const hasCache = !!cached;
        const showLoading = opts?.showLoading ?? !hasCache;

        if (hasCache) {
          // Keep prior week punches visible while refreshing — never flash empty zeros.
          setEntries(cached.entries);
          setSchema(cached.schema);
          setEntriesWeekKey(weekKey);
          setError(null);
          setLoading(!!showLoading && !!opts?.force);
        } else {
          // Do not keep a different week's punches — that paints false zeros under the new week label.
          setEntries([]);
          setEntriesWeekKey(null);
          if (showLoading) setLoading(true);
          setError(null);
        }

        try {
          const res = await loadWeekEntries(sb, bounds);
          if (!res.ok) {
            if (!hasCache) {
              setError(res.reason);
              setEntries([]);
              setEntriesWeekKey(null);
            }
          } else {
            const maxUpdatedAt = res.entries.reduce<string | null>((acc, e) => {
              const at = e.updated_at ? String(e.updated_at) : null;
              if (!at) return acc;
              if (!acc || at > acc) return at;
              return acc;
            }, null);
            entriesCacheRef.current.set(weekKey, {
              entries: res.entries,
              schema: res.schema,
              fetchedAt: Date.now(),
              maxUpdatedAt,
            });
            setEntries(res.entries);
            setSchema(res.schema);
            setEntriesWeekKey(weekKey);
            setError(null);
          }
        } finally {
          setLoading(false);
        }
      };

      // Serialize refreshes so await refresh() after save always sees post-save punches.
      const next = refreshChainRef.current.then(run, run);
      refreshChainRef.current = next.catch(() => {});
      await next;
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
      const weekKey = weekBoundsStorageKey(bounds);
      const cached = entriesCacheRef.current.get(weekKey);
      if (cached && Date.now() - cached.fetchedAt < WEEK_CACHE_FRESH_MS) {
        return;
      }
      entriesCacheRef.current.delete(weekKey);
      void runRefreshRef.current({ showLoading: false, force: true });
    });
  }, [bounds]);

  const setPayWeekStartIso = useCallback((startIso: string) => {
    void saveSelectedPayWeekStartIso(startIso);
    setSelectedWeekStartIso(startIso);
    const mon = new Date(`${startIso}T12:00:00`);
    setBounds(payWeekBoundsFromMonday(mon));
  }, []);

  const weekReady = ready && entriesWeekKey === boundsKey;

  const value = useMemo(
    () => ({
      entries,
      schema,
      loading: !ready || (loading && !weekReady),
      weekReady,
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
      weekReady,
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
