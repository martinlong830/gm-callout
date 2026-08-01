import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useT } from '../contexts/LocaleContext';

type Props = {
  error: Error;
  retry: () => void | Promise<void>;
};

/**
 * Shared fallback for Expo Router `ErrorBoundary` exports and RootErrorBoundary.
 * Keeps tab navigation usable after a single screen render failure.
 */
export function RouteErrorFallback({ error, retry }: Props) {
  const t = useT();
  const detail = String(error?.message || '').trim();
  return (
    <View style={styles.wrap}>
      <Text style={styles.title}>{t('errors.boundaryTitle')}</Text>
      <Text style={styles.body}>{t('errors.boundaryBody')}</Text>
      {detail ? <Text style={styles.detail}>{detail}</Text> : null}
      <Pressable
        style={styles.btn}
        onPress={() => {
          void retry();
        }}
        accessibilityRole="button"
      >
        <Text style={styles.btnText}>{t('common.tryAgain')}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#111',
    marginBottom: 8,
  },
  body: {
    fontSize: 15,
    color: '#444',
    lineHeight: 22,
  },
  detail: {
    marginTop: 12,
    fontSize: 12,
    color: '#94a3b8',
  },
  btn: {
    marginTop: 20,
    alignSelf: 'flex-start',
    backgroundColor: '#c41230',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 8,
  },
  btnText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
});
