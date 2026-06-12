import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

function formatIsoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

type Props = {
  label: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
  minimumDate?: Date;
  maximumDate?: Date;
};

export function DatePickerField({ label, value, onChange, minimumDate, maximumDate }: Props) {
  const [open, setOpen] = useState(false);

  const onPickerChange = (_ev: DateTimePickerEvent, picked?: Date) => {
    if (Platform.OS === 'android') setOpen(false);
    if (picked) onChange(picked);
  };

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <Pressable style={styles.btn} onPress={() => setOpen(true)}>
        <Text style={styles.btnText}>{value ? formatIsoDate(value) : 'Tap to choose date'}</Text>
      </Pressable>
      {open ? (
        <DateTimePicker
          value={value ?? new Date()}
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          onChange={onPickerChange}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
        />
      ) : null}
      {Platform.OS === 'ios' && open ? (
        <Pressable style={styles.done} onPress={() => setOpen(false)}>
          <Text style={styles.doneText}>Done</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 10 },
  label: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6, textTransform: 'uppercase' },
  btn: {
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    padding: 12,
    backgroundColor: '#fff',
  },
  btnText: { fontSize: 16, color: '#0f172a' },
  done: { marginTop: 8, alignItems: 'flex-end' },
  doneText: { color: '#c41230', fontWeight: '700', fontSize: 16 },
});
