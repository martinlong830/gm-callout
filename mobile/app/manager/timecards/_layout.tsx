import { Stack, type ErrorBoundaryProps } from 'expo-router';
import { RouteErrorFallback } from '../../../components/RouteErrorFallback';
import { TimecardsProvider } from '../../../contexts/TimecardsContext';
import { useI18n } from '../../../contexts/LocaleContext';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function TimecardsLayout() {
  const { t } = useI18n();
  return (
    <TimecardsProvider>
      <Stack
        screenOptions={{
          headerTintColor: '#c41230',
          headerBackTitle: t('common.back'),
        }}
      >
        <Stack.Screen name="index" options={{ title: t('title.timecards') }} />
        <Stack.Screen name="[employeeId]" options={{ title: t('title.employee') }} />
        <Stack.Screen name="[employeeId]/shift" options={{ title: t('title.shiftTimecard') }} />
      </Stack>
    </TimecardsProvider>
  );
}
