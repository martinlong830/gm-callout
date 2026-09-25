import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppData } from '../../contexts/AppDataContext';
import { useI18n } from '../../contexts/LocaleContext';
import {
  decimalHoursFromMinutes,
  formatPayAmount,
  type RosterTotals,
} from '../../lib/timecards/engine';
import type { LocationFilter } from '../../lib/timecards/restaurantAttribution';
import type { PayWeekBounds } from '../../lib/timecards/types';
import {
  formatTipRateInput,
  getPayrollTipPoolInputs,
  normalizeTipPoolRate,
  patchWeekTipPoolSlice,
  payrollTipPoolTotals,
  TIP_NET_RATE_DELIVERY,
  TIP_NET_RATE_SQUARE,
} from '../../lib/timecards/weekTipPool';

type Props = {
  totals: RosterTotals;
  bounds: PayWeekBounds;
  /** Active timecards location — tip pool is stored per restaurant. */
  locationFilter?: LocationFilter;
  /** When false, hides week-wide tip pool inputs (e.g. employee detail view). */
  showTipPool?: boolean;
  /** Replaces default "{n} employees" meta line. */
  metaLabel?: string;
  /** Shown as a Pay/hr tile on employee week summaries. */
  hourlyRateLabel?: string;
};

function TotalCard({
  label,
  hours,
  pay,
  emphasis,
}: {
  label: string;
  hours: string;
  pay?: string;
  emphasis?: 'hours' | 'pay';
}) {
  return (
    <View
      style={[
        styles.card,
        emphasis === 'hours' && styles.cardEmph,
        emphasis === 'pay' && styles.cardPay,
      ]}
    >
      <Text style={styles.cardLabel}>{label}</Text>
      <Text style={styles.cardValue}>{hours}</Text>
      {pay != null ? <Text style={styles.cardPayText}>{pay}</Text> : null}
    </View>
  );
}

type TipDraft = {
  squareTips: string;
  squarePickup: string;
  doordash: string;
  uber: string;
  cashTip: string;
};

type RateDraft = {
  squareNetRate: string;
  doordashNetRate: string;
  uberNetRate: string;
};

export function TipPoolKeepRatesEditor({
  bounds,
  locationFilter = 'rp-9',
}: {
  bounds: PayWeekBounds;
  locationFilter?: LocationFilter;
}) {
  const { t } = useI18n();
  const { teamState } = useAppData();
  const [draft, setDraft] = useState<RateDraft>({
    squareNetRate: formatTipRateInput(TIP_NET_RATE_SQUARE),
    doordashNetRate: formatTipRateInput(TIP_NET_RATE_DELIVERY),
    uberNetRate: formatTipRateInput(TIP_NET_RATE_DELIVERY),
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focusedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadRates = useCallback(async () => {
    const pool = await getPayrollTipPoolInputs(bounds, locationFilter);
    setDraft({
      squareNetRate: formatTipRateInput(pool.squareNetRate),
      doordashNetRate: formatTipRateInput(pool.doordashNetRate),
      uberNetRate: formatTipRateInput(pool.uberNetRate),
    });
  }, [bounds, locationFilter]);

  const persistRates = useCallback(
    async (next: RateDraft) => {
      await patchWeekTipPoolSlice(
        bounds,
        {
          squareNetRate: normalizeTipPoolRate(next.squareNetRate, TIP_NET_RATE_SQUARE),
          doordashNetRate: normalizeTipPoolRate(next.doordashNetRate, TIP_NET_RATE_DELIVERY),
          uberNetRate: normalizeTipPoolRate(next.uberNetRate, TIP_NET_RATE_DELIVERY),
        },
        locationFilter
      );
    },
    [bounds, locationFilter]
  );

  useEffect(() => {
    if (focusedRef.current) return;
    void loadRates();
  }, [loadRates, teamState?.updated_at]);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  const onChangeField = (key: keyof RateDraft, value: string) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        void persistRates(next);
      }, 250);
      return next;
    });
  };

  const flushPersist = () => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    void persistRates(draftRef.current);
  };

  const rateFields: { key: keyof RateDraft; label: string }[] = [
    { key: 'squareNetRate', label: t('timecards.squareKeepRate') },
    { key: 'doordashNetRate', label: t('timecards.doordashKeepRate') },
    { key: 'uberNetRate', label: t('timecards.uberKeepRate') },
  ];

  return (
    <View>
      <Text style={styles.panelTitle}>{t('timecards.keepRates')}</Text>
      <Text style={styles.tipsHint}>{t('timecards.keepRatesHint')}</Text>
      {rateFields.map((field) => (
        <View key={field.key}>
          <Text style={styles.label}>{field.label}</Text>
          <TextInput
            style={styles.input}
            value={draft[field.key]}
            onChangeText={(v) => onChangeField(field.key, v)}
            onFocus={() => {
              focusedRef.current = true;
            }}
            onBlur={() => {
              focusedRef.current = false;
            }}
            onEndEditing={flushPersist}
            keyboardType="decimal-pad"
          />
        </View>
      ))}
    </View>
  );
}

export function GrandTotalsSection({
  totals,
  bounds,
  locationFilter = 'rp-9',
  showTipPool = true,
  metaLabel,
  hourlyRateLabel,
}: Props) {
  const { t } = useI18n();
  const { teamState } = useAppData();
  const [draft, setDraft] = useState<TipDraft>({
    squareTips: '0',
    squarePickup: '0',
    doordash: '0',
    uber: '0',
    cashTip: '0',
  });
  const [tipSummary, setTipSummary] = useState('');
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const focusedRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadTips = useCallback(async () => {
    const pool = await getPayrollTipPoolInputs(bounds, locationFilter);
    setDraft({
      squareTips: String(pool.squareTips),
      squarePickup: String(pool.squarePickup),
      doordash: String(pool.doordash),
      uber: String(pool.uber),
      cashTip: String(pool.cashTip),
    });
    const tipTotals = payrollTipPoolTotals(pool);
    setTipSummary(
      t('timecards.tipPoolSummary', {
        totalTips: formatPayAmount(tipTotals.totalTips),
      })
    );
  }, [bounds, locationFilter, t]);

  const persistTips = useCallback(
    async (next: TipDraft) => {
      const existing = await getPayrollTipPoolInputs(bounds, locationFilter);
      const squarePickup = Math.max(0, parseFloat(next.squarePickup) || 0);
      const doordash = Math.max(0, parseFloat(next.doordash) || 0);
      const uber = Math.max(0, parseFloat(next.uber) || 0);
      const saved = await patchWeekTipPoolSlice(
        bounds,
        {
          squareTips: Math.max(0, parseFloat(next.squareTips) || 0),
          squarePickup,
          doordash,
          uber,
          cashTip: Math.max(0, parseFloat(next.cashTip) || 0),
          sqGhDd: squarePickup > 0 || doordash > 0 || uber > 0 ? 0 : existing.sqGhDd || 0,
        },
        locationFilter
      );
      const tipTotals = payrollTipPoolTotals(saved);
      setTipSummary(
        t('timecards.tipPoolSummary', {
          totalTips: formatPayAmount(tipTotals.totalTips),
        })
      );
    },
    [bounds, locationFilter, t]
  );

  const flushPersistTips = useCallback(() => {
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    void persistTips(draftRef.current);
  }, [persistTips]);

  useEffect(() => {
    if (!showTipPool) return;
    if (focusedRef.current) return;
    void loadTips();
  }, [loadTips, showTipPool, teamState?.updated_at]);

  useEffect(() => {
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, []);

  const onChangeField = (key: keyof TipDraft, value: string) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        void persistTips(next);
      }, 250);
      return next;
    });
  };

  const payReg = totals.hasRegPay ? formatPayAmount(totals.regPay) : '—';
  const payOt = totals.hasOtPay ? formatPayAmount(totals.otPay) : '—';
  const payVlSl = totals.hasVlSlPay
    ? `${formatPayAmount(totals.vlPay)} / ${formatPayAmount(totals.slPay)}`
    : '—';
  const paySoh = totals.hasSohPay ? formatPayAmount(totals.sohPay) : '—';
  const payDishwasherTips = totals.hasDishwasherTips
    ? formatPayAmount(totals.dishwasherTipsPay)
    : '—';
  const payCoverage = totals.hasAdditionalCashTip
    ? formatPayAmount(totals.additionalCashTip)
    : '—';
  const payTotal = totals.hasGrandTotal ? formatPayAmount(totals.grandTotalPay) : '—';
  const allPaidMins =
    totals.totalMins + Math.round(totals.vlHours * 60) + Math.round(totals.slHours * 60);

  const tipFields: { key: keyof TipDraft; label: string }[] = [
    { key: 'squarePickup', label: t('timecards.squarePickupTips') },
    { key: 'squareTips', label: t('timecards.squareInHouseTips') },
    { key: 'doordash', label: t('timecards.doordashTips') },
    { key: 'uber', label: t('timecards.uberTips') },
    { key: 'cashTip', label: t('timecards.cashTips') },
  ];

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t('timecards.grandTotals')}</Text>
      <Text style={styles.meta}>
        {metaLabel ?? t('timecards.employeesCount', { n: totals.headcount })}
      </Text>
      <View style={styles.grid}>
        <TotalCard
          label={t('timecards.scheduled')}
          hours={`${decimalHoursFromMinutes(totals.schedMins)}h`}
        />
        <TotalCard
          label={t('timecards.regular')}
          hours={`${decimalHoursFromMinutes(totals.regMins)}h`}
          pay={payReg}
        />
        <TotalCard
          label={t('timecards.overtime')}
          hours={`${decimalHoursFromMinutes(totals.otMins)}h`}
          pay={payOt}
        />
        <TotalCard
          label={t('timecards.vlSl')}
          hours={`${decimalHoursFromMinutes(totals.vlHours * 60)}h / ${decimalHoursFromMinutes(totals.slHours * 60)}h`}
          pay={payVlSl}
        />
        <TotalCard label={t('timecards.soh')} hours={String(totals.sohCount)} pay={paySoh} />
        <TotalCard label={t('timecards.netDishwasherTips')} hours={payDishwasherTips} />
        <TotalCard label={t('timecards.coverageCompensation')} hours={payCoverage} />
        {hourlyRateLabel != null ? (
          <TotalCard label={t('timecards.payHr')} hours={hourlyRateLabel} />
        ) : null}
        <TotalCard
          label={t('timecards.totalHours')}
          hours={`${decimalHoursFromMinutes(allPaidMins)}h`}
          emphasis="hours"
        />
        <TotalCard label={t('timecards.totalPay')} hours={payTotal} emphasis="pay" />
      </View>

      {showTipPool ? (
        <View style={styles.tips}>
          <Text style={styles.tipsTitle}>{t('timecards.tipPool')}</Text>
          <Text style={styles.tipsHint}>{t('timecards.grossTipsHint')}</Text>
          {tipFields.map((field) => (
            <View key={field.key}>
              <Text style={styles.label}>{field.label}</Text>
              <TextInput
                style={styles.input}
                value={draft[field.key]}
                onChangeText={(v) => onChangeField(field.key, v)}
                onFocus={() => {
                  focusedRef.current = true;
                }}
                onBlur={() => {
                  focusedRef.current = false;
                }}
                onEndEditing={flushPersistTips}
                keyboardType="decimal-pad"
              />
            </View>
          ))}
          {tipSummary ? <Text style={styles.tipSummary}>{tipSummary}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 12,
    padding: 14,
    backgroundColor: '#fff',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#e2e6ea',
  },
  title: { fontSize: 16, fontWeight: '700', color: '#0f172a' },
  meta: { fontSize: 13, color: '#64748b', marginTop: 4, marginBottom: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  card: {
    width: '47%',
    minWidth: 140,
    flexGrow: 1,
    padding: 10,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e8eaed',
    backgroundColor: '#fafbfc',
  },
  cardEmph: { backgroundColor: '#f1f5f9' },
  cardPay: { backgroundColor: '#fef2f2', borderColor: '#fecaca' },
  cardLabel: { fontSize: 11, fontWeight: '700', color: '#64748b', textTransform: 'uppercase' },
  cardValue: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginTop: 4 },
  cardPayText: { fontSize: 13, color: '#475569', marginTop: 2 },
  tips: {
    marginTop: 16,
    paddingTop: 14,
    borderTopWidth: 1,
    borderTopColor: '#e8eaed',
  },
  tipsTitle: { fontSize: 14, fontWeight: '700', color: '#334155' },
  panelTitle: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.4,
    textTransform: 'uppercase',
    color: '#64748b',
  },
  ratesPanel: {
    marginTop: 12,
    marginBottom: 14,
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    backgroundColor: '#f8fafc',
  },
  amountsPanel: {
    marginTop: 2,
  },
  tipsHint: { fontSize: 12, color: '#64748b', marginTop: 4, marginBottom: 6 },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 8, marginBottom: 2 },
  fieldHint: { fontSize: 11, color: '#94a3b8', marginBottom: 4 },
  input: {
    borderWidth: 1,
    borderColor: '#cbd5e1',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    backgroundColor: '#fff',
  },
  tipSummary: { fontSize: 12, color: '#334155', marginTop: 10, lineHeight: 18 },
});
