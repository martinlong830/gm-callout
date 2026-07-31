import { Stack } from 'expo-router';
import { TimecardsProvider } from '../../../contexts/TimecardsContext';
import { useI18n } from '../../../contexts/LocaleContext';

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
