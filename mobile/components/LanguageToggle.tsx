import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useI18n } from '../contexts/LocaleContext';
import type { Locale } from '../lib/i18n';

type Props = {
  /** Compact EN/ES segment (default) or full English/Español labels */
  variant?: 'compact' | 'full';
};

export function LanguageToggle({ variant = 'compact' }: Props) {
  const { locale, setLocale, t } = useI18n();

  function pick(next: Locale) {
    if (next !== locale) setLocale(next);
  }

  if (variant === 'full') {
    return (
      <View style={styles.block} accessibilityRole="summary">
        <Text style={styles.label}>{t('common.language')}</Text>
        <View style={styles.row}>
          <Pressable
            style={[styles.chip, locale === 'en' && styles.chipActive]}
            onPress={() => pick('en')}
            accessibilityRole="button"
            accessibilityState={{ selected: locale === 'en' }}
          >
            <Text style={[styles.chipText, locale === 'en' && styles.chipTextActive]}>
              {t('common.english')}
            </Text>
          </Pressable>
          <Pressable
            style={[styles.chip, locale === 'es' && styles.chipActive]}
            onPress={() => pick('es')}
            accessibilityRole="button"
            accessibilityState={{ selected: locale === 'es' }}
          >
            <Text style={[styles.chipText, locale === 'es' && styles.chipTextActive]}>
              {t('common.spanish')}
            </Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.compact} accessibilityRole="summary" accessibilityLabel={t('common.language')}>
      <Pressable
        style={[styles.compactBtn, locale === 'en' && styles.compactBtnActive]}
        onPress={() => pick('en')}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ selected: locale === 'en' }}
      >
        <Text style={[styles.compactText, locale === 'en' && styles.compactTextActive]}>EN</Text>
      </Pressable>
      <Pressable
        style={[styles.compactBtn, locale === 'es' && styles.compactBtnActive]}
        onPress={() => pick('es')}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ selected: locale === 'es' }}
      >
        <Text style={[styles.compactText, locale === 'es' && styles.compactTextActive]}>ES</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginBottom: 16 },
  label: { fontSize: 13, fontWeight: '600', color: '#333', marginBottom: 8 },
  row: { flexDirection: 'row', gap: 8 },
  chip: {
    flex: 1,
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#fafbfc',
  },
  chipActive: { borderColor: '#1e3a5f', backgroundColor: '#1e3a5f' },
  chipText: { fontSize: 15, fontWeight: '600', color: '#334155' },
  chipTextActive: { color: '#fff' },
  compact: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: '#ccd2d8',
    borderRadius: 8,
    overflow: 'hidden',
    marginRight: 4,
  },
  compactBtn: {
    paddingHorizontal: 8,
    paddingVertical: 5,
    backgroundColor: '#fff',
  },
  compactBtnActive: { backgroundColor: '#1e3a5f' },
  compactText: { fontSize: 12, fontWeight: '700', color: '#64748b' },
  compactTextActive: { color: '#fff' },
});
