import { useCallback, useMemo, useState } from 'react';
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useAppData } from '../contexts/AppDataContext';
import { useI18n } from '../contexts/LocaleContext';
import {
  formatHolidayDateLabel,
  localTodayIso,
  normalizeCompanyHolidays,
  persistCompanyHolidays,
  removeCompanyHoliday,
  upsertCompanyHoliday,
  type CompanyHoliday,
} from '../lib/companyHolidays';
import { isSupabaseConfigured, supabase } from '../lib/supabase';

type Props = {
  visible: boolean;
  onClose: () => void;
};

export function CompanyHolidaysSheet({ visible, onClose }: Props) {
  const { t } = useI18n();
  const { teamState, refetch } = useAppData();
  const [dateIso, setDateIso] = useState(localTodayIso());
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [localOverride, setLocalOverride] = useState<CompanyHoliday[] | null>(null);

  const holidays = useMemo(() => {
    if (localOverride) return localOverride;
    return normalizeCompanyHolidays(teamState?.company_holidays);
  }, [localOverride, teamState?.company_holidays]);

  const persist = useCallback(
    async (next: CompanyHoliday[]) => {
      if (!supabase || !isSupabaseConfigured) {
        Alert.alert(t('schedule.holidays'), t('errors.generic'));
        return false;
      }
      setBusy(true);
      try {
        const res = await persistCompanyHolidays(supabase, next);
        if (!res.ok) {
          Alert.alert(t('schedule.holidays'), res.message);
          return false;
        }
        setLocalOverride(next);
        void refetch({ silent: true });
        return true;
      } finally {
        setBusy(false);
      }
    },
    [refetch, t]
  );

  const onAdd = useCallback(async () => {
    if (!dateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dateIso.slice(0, 10)) || !name.trim()) {
      Alert.alert(t('schedule.holidays'), t('schedule.holidayInvalid'));
      return;
    }
    const next = upsertCompanyHoliday(holidays, { iso: dateIso, name });
    const ok = await persist(next);
    if (ok) setName('');
  }, [dateIso, holidays, name, persist, t]);

  const onRemove = useCallback(
    async (h: CompanyHoliday) => {
      const next = removeCompanyHoliday(holidays, h.id);
      await persist(next);
    },
    [holidays, persist]
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>{t('schedule.holidays')}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>{t('common.close')}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>{t('schedule.holidaysHint')}</Text>
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 8 }}>
            {!holidays.length ? (
              <Text style={styles.empty}>{t('schedule.noHolidaysYet')}</Text>
            ) : (
              holidays.map((h) => (
                <View key={h.id} style={styles.row}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.rowDate}>{formatHolidayDateLabel(h.iso)}</Text>
                    <Text style={styles.rowName}>{h.name}</Text>
                  </View>
                  <Pressable onPress={() => void onRemove(h)} disabled={busy}>
                    <Text style={styles.remove}>{t('common.remove')}</Text>
                  </Pressable>
                </View>
              ))
            )}
          </ScrollView>
          <Text style={styles.label}>{t('schedule.holidayDate')}</Text>
          <TextInput
            style={styles.input}
            value={dateIso}
            onChangeText={setDateIso}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={styles.label}>{t('schedule.holidayName')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Christmas"
            maxLength={80}
          />
          <Pressable
            style={[styles.addBtn, busy && styles.addBtnDisabled]}
            onPress={() => void onAdd()}
            disabled={busy}
          >
            <Text style={styles.addBtnText}>{t('schedule.addHoliday')}</Text>
          </Pressable>
          <Pressable style={styles.doneBtn} onPress={onClose}>
            <Text style={styles.doneText}>{t('common.done')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15,23,42,0.45)',
    justifyContent: 'flex-end',
  },
  sheet: {
    maxHeight: '88%',
    backgroundColor: '#fff',
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    paddingBottom: 28,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { fontSize: 18, fontWeight: '700', color: '#111' },
  close: { fontSize: 15, fontWeight: '600', color: '#c41230' },
  hint: { marginTop: 8, fontSize: 13, color: '#64748b', lineHeight: 18 },
  list: { marginTop: 12, maxHeight: 220 },
  empty: { fontSize: 14, color: '#888', paddingVertical: 12 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eef2f7',
  },
  rowDate: { fontSize: 12, fontWeight: '700', color: '#c2410c' },
  rowName: { fontSize: 15, fontWeight: '600', color: '#111', marginTop: 2 },
  remove: { fontSize: 13, fontWeight: '600', color: '#64748b' },
  label: { marginTop: 12, fontSize: 12, fontWeight: '700', color: '#64748b' },
  input: {
    marginTop: 6,
    borderWidth: 1,
    borderColor: '#e2e8f0',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 15,
    color: '#111',
  },
  addBtn: {
    marginTop: 14,
    backgroundColor: '#c41230',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  addBtnDisabled: { opacity: 0.5 },
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  doneBtn: { marginTop: 10, paddingVertical: 10, alignItems: 'center' },
  doneText: { fontSize: 15, fontWeight: '600', color: '#475569' },
});
