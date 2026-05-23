import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  formatDateTimePickerLabel,
  formatEditableDateTime,
  parseEditableDateTime,
} from '../lib/timecards/punch';

type Props = {
  label: string;
  value: Date | null;
  onChange: (value: Date | null) => void;
  maximumDate?: Date;
  minimumDate?: Date;
  /** When true, show a control to clear the value (e.g. open punch = no clock out). */
  allowClear?: boolean;
  clearLabel?: string;
};

/**
 * Date/time field with typeable text (YYYY-MM-DD HH:MM or M/D/YYYY H:MM AM) plus native picker.
 */
export function DateTimePickerField({
  label,
  value,
  onChange,
  maximumDate = new Date(),
  minimumDate,
  allowClear = false,
  clearLabel = 'Still clocked in',
}: Props) {
  const [text, setText] = useState('');
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(value ?? new Date());
  const [androidStep, setAndroidStep] = useState<'none' | 'date' | 'time'>('none');
  const [pendingDate, setPendingDate] = useState<Date | null>(null);

  useEffect(() => {
    setText(value ? formatEditableDateTime(value) : '');
  }, [value]);

  useEffect(() => {
    if (iosOpen) setIosDraft(value ?? new Date());
  }, [iosOpen, value]);

  const pickerValue = value ?? pendingDate ?? maximumDate ?? new Date();

  function applyDate(d: Date) {
    onChange(d);
  }

  function commitText(raw?: string) {
    const input = raw ?? text;
    if (!input.trim()) {
      if (allowClear) onChange(null);
      setText('');
      return;
    }
    const parsed = parseEditableDateTime(input);
    if (!parsed) {
      setText(value ? formatEditableDateTime(value) : '');
      return;
    }
    if (maximumDate && parsed.getTime() > maximumDate.getTime()) {
      setText(value ? formatEditableDateTime(value) : '');
      return;
    }
    if (minimumDate && parsed.getTime() < minimumDate.getTime()) {
      setText(value ? formatEditableDateTime(value) : '');
      return;
    }
    applyDate(parsed);
    setText(formatEditableDateTime(parsed));
  }

  function onPickerChange(event: DateTimePickerEvent, selected?: Date) {
    if (event.type === 'dismissed') {
      setIosOpen(false);
      setAndroidStep('none');
      setPendingDate(null);
      return;
    }
    if (!selected || Number.isNaN(selected.getTime())) return;

    if (Platform.OS === 'android') {
      if (androidStep === 'date') {
        setPendingDate(selected);
        setAndroidStep('time');
        return;
      }
      if (androidStep === 'time' && pendingDate) {
        const merged = new Date(pendingDate);
        merged.setHours(selected.getHours(), selected.getMinutes(), 0, 0);
        applyDate(merged);
        setAndroidStep('none');
        setPendingDate(null);
      }
      return;
    }

    setIosDraft(selected);
  }

  function closeIosPicker() {
    applyDate(iosDraft);
    setIosOpen(false);
  }

  function openPicker() {
    if (Platform.OS === 'android') {
      setPendingDate(value);
      setAndroidStep('date');
    } else {
      setIosOpen(true);
    }
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.textInput}
          value={text}
          onChangeText={setText}
          onBlur={() => commitText()}
          onSubmitEditing={() => commitText()}
          placeholder="YYYY-MM-DD HH:MM or 5/18/2026 2:30 PM"
          placeholderTextColor="#94a3b8"
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
        />
        <Pressable style={styles.pickBtn} onPress={openPicker} accessibilityRole="button">
          <Text style={styles.pickBtnText}>Pick</Text>
        </Pressable>
      </View>
      <Text style={styles.hint}>
        {value ? formatDateTimePickerLabel(value) : 'Type a time or tap Pick'}
      </Text>
      {allowClear ? (
        <Pressable
          style={styles.clearBtn}
          onPress={() => onChange(null)}
          accessibilityRole="button"
        >
          <Text style={styles.clearText}>{clearLabel}</Text>
        </Pressable>
      ) : null}

      {Platform.OS === 'ios' && iosOpen ? (
        <View style={styles.iosPickerBox}>
          <DateTimePicker
            value={iosDraft}
            mode="datetime"
            display="spinner"
            maximumDate={maximumDate}
            minimumDate={minimumDate}
            onChange={(e, d) => {
              if (e.type === 'dismissed') {
                setIosOpen(false);
                return;
              }
              if (d) setIosDraft(d);
            }}
          />
          <Pressable style={styles.doneBtn} onPress={closeIosPicker}>
            <Text style={styles.doneText}>Done</Text>
          </Pressable>
        </View>
      ) : null}

      {Platform.OS === 'android' && androidStep !== 'none' ? (
        <DateTimePicker
          value={androidStep === 'date' ? pickerValue : pendingDate ?? pickerValue}
          mode={androidStep}
          display="default"
          maximumDate={androidStep === 'date' ? maximumDate : undefined}
          minimumDate={androidStep === 'date' ? minimumDate : minimumDate}
          onChange={onPickerChange}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { marginBottom: 4 },
  label: { fontSize: 12, fontWeight: '600', color: '#64748b', marginBottom: 6, marginTop: 8 },
  inputRow: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
  textInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: '#fff',
    fontSize: 16,
    color: '#0f172a',
  },
  pickBtn: {
    borderWidth: 1,
    borderColor: '#c41230',
    borderRadius: 8,
    paddingHorizontal: 14,
    justifyContent: 'center',
    backgroundColor: '#fff',
  },
  pickBtnText: { fontSize: 14, fontWeight: '700', color: '#c41230' },
  hint: { fontSize: 12, color: '#94a3b8', marginTop: 6 },
  clearBtn: { alignSelf: 'flex-start', marginTop: 8, paddingVertical: 4 },
  clearText: { fontSize: 14, fontWeight: '600', color: '#64748b' },
  iosPickerBox: {
    marginTop: 8,
    backgroundColor: '#fff',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#e2e6ea',
    overflow: 'hidden',
  },
  doneBtn: {
    borderTopWidth: 1,
    borderTopColor: '#e2e6ea',
    padding: 12,
    alignItems: 'center',
  },
  doneText: { fontSize: 16, fontWeight: '700', color: '#c41230' },
});
