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
  getPayrollTipPoolInputs,
  payrollTipPoolTotals,
  saveWeekTipPoolSlice,
  type TipPoolInputs,
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

function draftToPool(draft: TipDraft): TipPoolInputs {
  return {
    squareTips: Math.max(0, parseFloat(draft.squareTips) || 0),
    squarePickup: Math.max(0, parseFloat(draft.squarePickup) || 0),
    doordash: Math.max(0, parseFloat(draft.doordash) || 0),
    uber: Math.max(0, parseFloat(draft.uber) || 0),
    cashTip: Math.max(0, parseFloat(draft.cashTip) || 0),
    sqGhDd: 0,
    manual: true,
  };
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

  const updateSummary = useCallback(
    (pool: TipPoolInputs) => {
      const tipTotals = payrollTipPoolTotals(pool);
      setTipSummary(
        t('timecards.tipPoolSummary', {
          squareInhouse: formatPayAmount(tipTotals.squareInhouse),
          sqGhDd: formatPayAmount(tipTotals.sqGhDd),
          totalTips: formatPayAmount(tipTotals.totalTips),
        })
      );
    },
    [t]
  );

  const loadTips = useCallback(async () => {
    const pool = await getPayrollTipPoolInputs(bounds, locationFilter);
    setDraft({
      squareTips: String(pool.squareTips),
      squarePickup: String(pool.squarePickup),
      doordash: String(pool.doordash),
      uber: String(pool.uber),
      cashTip: String(pool.cashTip),
    });
    updateSummary(pool);
  }, [bounds, locationFilter, updateSummary]);

  const persistTips = useCallback(
    async (next: TipDraft) => {
      const pool = draftToPool(next);
      const existing = await getPayrollTipPoolInputs(bounds, locationFilter);
      if (!(pool.squarePickup > 0 || pool.doordash > 0 || pool.uber > 0)) {
        pool.sqGhDd = existing.sqGhDd || 0;
      }
      await saveWeekTipPoolSlice(bounds, pool, locationFilter);
      updateSummary(pool);
    },
    [bounds, locationFilter, updateSummary]
  );

  useEffect(() => {
    if (showTipPool) void loadTips();
  }, [loadTips, showTipPool, teamState?.updated_at]);

  const onChangeField = (key: keyof TipDraft, value: string) => {
    setDraft((prev) => {
      const next = { ...prev, [key]: value };
      updateSummary(draftToPool(next));
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

  const tipFields: { key: keyof TipDraft; label: string; hint?: string }[] = [
    { key: 'squareTips', label: t('timecards.squareInHouseTips'), hint: t('timecards.tipRateSquare') },
    { key: 'squarePickup', label: t('timecards.squarePickupTips'), hint: t('timecards.tipRateSquare') },
    { key: 'doordash', label: t('timecards.doordashTips'), hint: t('timecards.tipRateDelivery') },
    { key: 'uber', label: t('timecards.uberTips'), hint: t('timecards.tipRateDelivery') },
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
          <Text style={styles.tipsHint}>{t('timecards.tipPoolHint')}</Text>
          {tipFields.map((field) => (
            <View key={field.key}>
              <Text style={styles.label}>{field.label}</Text>
              {field.hint ? <Text style={styles.fieldHint}>{field.hint}</Text> : null}
              <TextInput
                style={styles.input}
                value={draft[field.key]}
                onChangeText={(v) => onChangeField(field.key, v)}
                onEndEditing={() => void persistTips(draftRef.current)}
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
  tipsHint: { fontSize: 12, color: '#64748b', marginTop: 4, marginBottom: 10 },
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
