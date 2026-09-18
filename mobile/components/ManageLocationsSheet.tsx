import { useState } from 'react';
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
import { useI18n } from '../contexts/LocaleContext';
import type { Restaurant } from '../lib/schedule/types';

type Props = {
  visible: boolean;
  restaurants: Restaurant[];
  onClose: () => void;
  onChange: (next: Restaurant[]) => void;
};

export function ManageLocationsSheet({ visible, restaurants, onClose, onChange }: Props) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [shortLabel, setShortLabel] = useState('');

  const onAdd = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      Alert.alert(t('schedule.manageLocations'), t('common.required'));
      return;
    }
    const id = `rest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const short = shortLabel.trim() || trimmed.slice(0, 14);
    onChange(
      restaurants.concat({
        id,
        name: trimmed,
        shortLabel: short,
        defaultUnassignedSchedule: true,
      })
    );
    setName('');
    setShortLabel('');
  };

  const onRemove = (r: Restaurant) => {
    if (restaurants.length <= 1) {
      Alert.alert(t('schedule.manageLocations'), t('schedule.atLeastOneLocation'));
      return;
    }
    Alert.alert(t('schedule.removeLocation'), t('schedule.locationRemoveConfirm', { name: r.name }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.remove'),
        style: 'destructive',
        onPress: () => onChange(restaurants.filter((x) => x.id !== r.id)),
      },
    ]);
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <View style={styles.head}>
            <Text style={styles.title}>{t('schedule.manageLocations')}</Text>
            <Pressable onPress={onClose} hitSlop={8}>
              <Text style={styles.close}>{t('common.close')}</Text>
            </Pressable>
          </View>
          <Text style={styles.hint}>{t('schedule.manageLocationsHint')}</Text>
          <ScrollView style={styles.list} contentContainerStyle={{ paddingBottom: 8 }}>
            {restaurants.map((r) => (
              <View key={r.id} style={styles.row}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.rowName}>{r.name}</Text>
                  <Text style={styles.rowShort}>{r.shortLabel}</Text>
                </View>
                <Pressable onPress={() => onRemove(r)}>
                  <Text style={styles.remove}>{t('common.remove')}</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
          <Text style={styles.label}>{t('schedule.locationName')}</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="e.g. Red Poke Downtown"
            maxLength={120}
          />
          <Text style={styles.label}>{t('schedule.locationShortLabel')}</Text>
          <TextInput
            style={styles.input}
            value={shortLabel}
            onChangeText={setShortLabel}
            placeholder="For compact chips"
            maxLength={24}
          />
          <Pressable style={styles.addBtn} onPress={onAdd}>
            <Text style={styles.addBtnText}>{t('schedule.addLocation')}</Text>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: '#eef2f7',
  },
  rowName: { fontSize: 15, fontWeight: '600', color: '#111' },
  rowShort: { fontSize: 12, color: '#64748b', marginTop: 2 },
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
  addBtnText: { color: '#fff', fontWeight: '700', fontSize: 15 },
  doneBtn: { marginTop: 10, paddingVertical: 10, alignItems: 'center' },
  doneText: { fontSize: 15, fontWeight: '600', color: '#475569' },
});
