import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { loadWeekEntries } from '../lib/timecards/entriesApi';
import { formatPayWeekLabel, getPayWeekBounds } from '../lib/timecards/payWeek';
import type { TimecardSchema, TimeClockEntry } from '../lib/timecards/types';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type TimecardsState = {
  entries: TimeClockEntry[];
  schema: TimecardSchema;
  loading: boolean;
  error: string | null;
  weekLabel: string;
  refresh: () => Promise<void>;
};

const TimecardsContext = createContext<TimecardsState | null>(null);

export function TimecardsProvider({ children }: { children: React.ReactNode }) {
  const bounds = useMemo(() => getPayWeekBounds(), []);
  const weekLabel = useMemo(() => formatPayWeekLabel(bounds), [bounds]);
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

  const refresh = useCallback(async () => {
    if (!isSupabaseConfigured || !supabase) {
      setEntries([]);
      setError('Supabase is not configured.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const res = await loadWeekEntries(supabase);
    if (!res.ok) {
      setError(res.reason);
      setEntries([]);
    } else {
      setEntries(res.entries);
      setSchema(res.schema);
    }
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(
    () => ({ entries, schema, loading, error, weekLabel, refresh }),
    [entries, schema, loading, error, weekLabel, refresh]
  );

  return <TimecardsContext.Provider value={value}>{children}</TimecardsContext.Provider>;
}

export function useTimecards(): TimecardsState {
  const ctx = useContext(TimecardsContext);
  if (!ctx) throw new Error('useTimecards must be used within TimecardsProvider');
  return ctx;
}
