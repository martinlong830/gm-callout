import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { useAppData } from '../../contexts/AppDataContext';
import {
  decimalHoursFromMinutes,
  formatPayAmount,
  type RosterTotals,
} from '../../lib/timecards/engine';
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

export function GrandTotalsSection({
  totals,
  bounds,
  showTipPool = true,
  metaLabel,
  hourlyRateLabel,
}: Props) {
  const { teamState } = useAppData();
  const [cash, setCash] = useState('0');
  const [sqGhDd, setSqGhDd] = useState('0');
  const [square, setSquare] = useState('0');
  const [tipSummary, setTipSummary] = useState('');

  const loadTips = useCallback(async () => {
    const pool = await getPayrollTipPoolInputs(bounds);
    setCash(String(pool.cashTip));
    setSqGhDd(String(pool.sqGhDd));
    setSquare(String(pool.squareTips));
    updateSummary(pool);
  }, [bounds]);

  const updateSummary = (pool: TipPoolInputs) => {
    const t = payrollTipPoolTotals(pool);
    setTipSummary(
      `Square In House (Net): ${formatPayAmount(t.squareInhouse)} · Total tips: ${formatPayAmount(t.totalTips)}`
    );
  };

  const persistTips = useCallback(
    async (next: { cashTip: string; sqGhDd: string; squareTips: string }) => {
      const pool: TipPoolInputs = {
        cashTip: parseFloat(next.cashTip) || 0,
        sqGhDd: parseFloat(next.sqGhDd) || 0,
        squareTips: parseFloat(next.squareTips) || 0,
        feePercent: 0.03,
        manual: true,
      };
      await saveWeekTipPoolSlice(bounds, pool);
      updateSummary(pool);
    },
    [bounds]
  );

  useEffect(() => {
    if (showTipPool) void loadTips();
  }, [loadTips, showTipPool, teamState?.updated_at]);

  const payReg = totals.hasRegPay ? formatPayAmount(totals.regPay) : '—';
  const payOt = totals.hasOtPay ? formatPayAmount(totals.otPay) : '—';
  const payVlSl = totals.hasVlSlPay
    ? `${formatPayAmount(totals.vlPay)} / ${formatPayAmount(totals.slPay)}`
    : '—';
  const paySoh = totals.hasSohPay ? formatPayAmount(totals.sohPay) : '—';
  const payDishwasherTips = totals.hasDishwasherTips
    ? formatPayAmount(totals.dishwasherTipsPay)
    : '—';
  const payTotal = totals.hasGrandTotal ? formatPayAmount(totals.grandTotalPay) : '—';
  const allPaidMins =
    totals.totalMins + Math.round(totals.vlHours * 60) + Math.round(totals.slHours * 60);

  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>Grand totals</Text>
      <Text style={styles.meta}>{metaLabel ?? `${totals.headcount} employees`}</Text>
      <View style={styles.grid}>
        <TotalCard
          label="Scheduled"
          hours={`${decimalHoursFromMinutes(totals.schedMins)}h`}
        />
        <TotalCard
          label="Regular"
          hours={`${decimalHoursFromMinutes(totals.regMins)}h`}
          pay={payReg}
        />
        <TotalCard
          label="Overtime"
          hours={`${decimalHoursFromMinutes(totals.otMins)}h`}
          pay={payOt}
        />
        <TotalCard
          label="VL / SL"
          hours={`${decimalHoursFromMinutes(totals.vlHours * 60)}h / ${decimalHoursFromMinutes(totals.slHours * 60)}h`}
          pay={payVlSl}
        />
        <TotalCard label="SoH" hours={String(totals.sohCount)} pay={paySoh} />
        <TotalCard label="Dishwasher tips" hours={payDishwasherTips} />
        {hourlyRateLabel != null ? (
          <TotalCard label="Pay/hr" hours={hourlyRateLabel} />
        ) : null}
        <TotalCard
          label="Total hours"
          hours={`${decimalHoursFromMinutes(allPaidMins)}h`}
          emphasis="hours"
        />
        <TotalCard label="Total pay" hours={payTotal} emphasis="pay" />
      </View>

      {showTipPool ? (
        <View style={styles.tips}>
          <Text style={styles.tipsTitle}>Tip pool</Text>
          <Text style={styles.tipsHint}>Used for payroll calculations (saved per pay week).</Text>
          <Text style={styles.label}>Square In House Tips</Text>
          <TextInput
            style={styles.input}
            value={square}
            onChangeText={setSquare}
            onEndEditing={() => void persistTips({ cashTip: cash, sqGhDd, squareTips: square })}
            keyboardType="decimal-pad"
          />
          <Text style={styles.label}>Cash Tips</Text>
          <TextInput
            style={styles.input}
            value={cash}
            onChangeText={setCash}
            onEndEditing={() => void persistTips({ cashTip: cash, sqGhDd, squareTips: square })}
            keyboardType="decimal-pad"
          />
          <Text style={styles.label}>SQ/GH/DD</Text>
          <TextInput
            style={styles.input}
            value={sqGhDd}
            onChangeText={setSqGhDd}
            onEndEditing={() => void persistTips({ cashTip: cash, sqGhDd, squareTips: square })}
            keyboardType="decimal-pad"
          />
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
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginTop: 8, marginBottom: 4 },
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
