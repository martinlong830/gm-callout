import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CompactShiftRow } from './CompactShiftRow';
import { ScheduleWeekPicker } from './ScheduleWeekPicker';
import { useI18n } from '../contexts/LocaleContext';
import {
  formatHolidayDateLabel,
  upcomingHolidaysInWindow,
  type CompanyHoliday,
} from '../lib/companyHolidays';
import { partitionShiftsByWeekStart } from '../lib/schedule/employeeShiftDisplay';
import type { WorkerShiftRow } from '../lib/schedule/engine';
import type { WeekMeta } from '../lib/schedule/types';

type Props = {
  today: WorkerShiftRow[];
  upcoming: WorkerShiftRow[];
  past: WorkerShiftRow[];
  holidays: CompanyHoliday[];
  weekMeta: WeekMeta[];
};

/** Shared Home schedule sections: today, upcoming (published), holidays, past dropdown. */
export function HomeScheduleSections({ today, upcoming, past, holidays, weekMeta }: Props) {
  const { t } = useI18n();
  const [upcomingWeekCursor, setUpcomingWeekCursor] = useState(0);
  const [pastOpen, setPastOpen] = useState(false);

  const upcomingGrouped = useMemo(() => partitionShiftsByWeekStart(upcoming), [upcoming]);
  const upcomingWeekRows = useMemo(() => {
    const wk = upcomingGrouped.order[upcomingWeekCursor];
    return wk ? upcomingGrouped.byWeek[wk] ?? [] : [];
  }, [upcomingGrouped, upcomingWeekCursor]);

  const upcomingHolidays = useMemo(() => upcomingHolidaysInWindow(holidays, { days: 28 }), [holidays]);

  return (
    <>
      <Text style={styles.sectionLabel}>{t('common.today')}</Text>
      {!today.length ? (
        <Text style={styles.muted}>{t('employee.noShiftsToday')}</Text>
      ) : (
        today.map((row) => (
          <CompactShiftRow key={`t-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />
        ))
      )}

      <View style={styles.upcomingHead}>
        <Text style={[styles.sectionLabel, styles.sectionSpaced]}>{t('employee.upcomingShifts')}</Text>
        {upcomingGrouped.order.length ? (
          <ScheduleWeekPicker
            mode="pager"
            weekMeta={weekMeta}
            weekStartIsos={upcomingGrouped.order}
            cursor={upcomingWeekCursor}
            onCursorChange={setUpcomingWeekCursor}
          />
        ) : null}
      </View>
      {!upcomingGrouped.order.length ? (
        <Text style={styles.muted}>{t('employee.noLaterShifts')}</Text>
      ) : !upcomingWeekRows.length ? (
        <Text style={styles.muted}>{t('employee.noShiftsThisWeek')}</Text>
      ) : (
        upcomingWeekRows.map((row) => (
          <CompactShiftRow key={`u-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />
        ))
      )}

      <Text style={[styles.sectionLabel, styles.sectionSpaced]}>{t('employee.upcomingHolidays')}</Text>
      {!upcomingHolidays.length ? (
        <Text style={styles.muted}>{t('employee.noUpcomingHolidays')}</Text>
      ) : (
        upcomingHolidays.map((h) => (
          <View key={h.id} style={styles.holidayRow}>
            <Text style={styles.holidayDate}>{formatHolidayDateLabel(h.iso)}</Text>
            <Text style={styles.holidayName}>{h.name}</Text>
          </View>
        ))
      )}

      <Pressable
        style={styles.historyToggle}
        onPress={() => setPastOpen((v) => !v)}
        accessibilityRole="button"
        accessibilityState={{ expanded: pastOpen }}
      >
        <Text style={styles.historyToggleText}>{t('employee.pastShifts')}</Text>
        <Text style={[styles.chevron, pastOpen && styles.chevronOpen]}>▾</Text>
      </Pressable>
      {pastOpen ? (
        !past.length ? (
          <Text style={styles.muted}>{t('employee.noPastShifts')}</Text>
        ) : (
          past.map((row) => (
            <CompactShiftRow key={`p-${row.restaurantId}-${row.id}-${row.iso}`} row={row} />
          ))
        )
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  sectionLabel: { fontSize: 11, fontWeight: '700', color: '#64748b', letterSpacing: 0.5, marginTop: 4 },
  sectionSpaced: { marginTop: 14 },
  upcomingHead: { marginTop: 4 },
  muted: { fontSize: 14, color: '#888', marginTop: 4 },
  holidayRow: {
    marginTop: 8,
    paddingVertical: 8,
    borderTopWidth: 1,
    borderTopColor: '#eee',
  },
  holidayDate: { fontSize: 11, fontWeight: '700', color: '#c2410c', textTransform: 'uppercase' },
  holidayName: { fontSize: 15, fontWeight: '600', color: '#111', marginTop: 2 },
  historyToggle: {
    marginTop: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  historyToggleText: { fontSize: 13, fontWeight: '700', color: '#334155', textTransform: 'uppercase' },
  chevron: { fontSize: 14, color: '#64748b' },
  chevronOpen: { transform: [{ rotate: '180deg' }] },
});
