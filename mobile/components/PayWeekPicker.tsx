import { useMemo, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import type { PayWeekOption } from '../lib/timecards/payWeek';

type Props = {
  options: PayWeekOption[];
  selectedStartIso: string;
  onSelect: (startIso: string) => void;
};

export function PayWeekPicker({ options, selectedStartIso, onSelect }: Props) {
  const [open, setOpen] = useState(false);

  const selectedLabel = useMemo(() => {
    const match = options.find((o) => o.startIso === selectedStartIso);
    return match?.label ?? 'Select pay week';
  }, [options, selectedStartIso]);

  function pick(startIso: string) {
    setOpen(false);
    if (startIso !== selectedStartIso) onSelect(startIso);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Pay week</Text>
      <Pressable
        style={styles.trigger}
        onPress={() => setOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Pay week: ${selectedLabel}`}
      >
        <Text style={styles.triggerText} numberOfLines={2}>
          {selectedLabel}
        </Text>
        <Text style={styles.chevron}>▾</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable style={styles.backdrop} onPress={() => setOpen(false)}>
          <Pressable style={styles.sheet} onPress={() => {}}>
            <Text style={styles.sheetTitle}>Select pay week</Text>
            <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">
              {options.map((opt) => {
                const on = opt.startIso === selectedStartIso;
                return (
                  <Pressable
                    key={opt.startIso}
                    style={[styles.option, on && styles.optionOn]}
                    onPress={() => pick(opt.startIso)}
                  >
                    <Text style={[styles.optionText, on && styles.optionTextOn]} numberOfLines={2}>
                      {opt.label}
                    </Text>
                  </Pressable>
                );
              })}
            </ScrollView>
            <Pressable style={styles.cancelBtn} onPress={() => setOpen(false)}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  label: { fontSize: 12, fontWeight: '700', color: '#64748b', marginBottom: 6, textTransform: 'uppercase' },
  trigger: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: '#cbd5e1',
    backgroundColor: '#fff',
  },
  triggerText: { flex: 1, fontSize: 14, fontWeight: '600', color: '#0f172a' },
  chevron: { fontSize: 14, color: '#64748b' },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.45)',
    justifyContent: 'center',
    padding: 24,
  },
  sheet: {
    maxHeight: '70%',
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
  },
  sheetTitle: { fontSize: 16, fontWeight: '700', color: '#0f172a', marginBottom: 12 },
  list: { maxHeight: 360 },
  option: {
    paddingVertical: 12,
    paddingHorizontal: 10,
    borderRadius: 8,
    marginBottom: 4,
  },
  optionOn: { backgroundColor: '#fef2f2' },
  optionText: { fontSize: 14, color: '#334155' },
  optionTextOn: { color: '#c41230', fontWeight: '700' },
  cancelBtn: { marginTop: 12, alignItems: 'center', paddingVertical: 10 },
  cancelText: { fontSize: 15, fontWeight: '600', color: '#64748b' },
});
