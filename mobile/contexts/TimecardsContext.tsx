import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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
  type PayWeekOption,
} from '../lib/timecards/payWeek';
import type { PayWeekBounds, TimecardSchema, TimeClockEntry } from '../lib/timecards/types';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

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

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setEntries([]);
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await loadWeekEntries(supabase, bounds);
    if (!res.ok) {
      setError(res.reason);
      setEntries([]);
    } else {
      setEntries(res.entries);
      setSchema(res.schema);
    }
    setLoading(false);
  }, [bounds]);

  useEffect(() => {
    if (ready) void refresh();
  }, [ready, bounds, refresh]);

  const setPayWeekStartIso = useCallback(async (startIso: string) => {
    await saveSelectedPayWeekStartIso(startIso);
    setSelectedWeekStartIso(startIso);
    const mon = new Date(`${startIso}T12:00:00`);
    setBounds(payWeekBoundsFromMonday(mon));
  }, []);

  const value = useMemo(
    () => ({
      entries,
      schema,
      loading: !ready || loading,
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
