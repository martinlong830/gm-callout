import { Stack } from 'expo-router';
import { TimecardsProvider } from '../../../contexts/TimecardsContext';

export default function TimecardsLayout() {
  return (
    <TimecardsProvider>
      <Stack
        screenOptions={{
          headerTintColor: '#c41230',
          headerBackTitle: 'Back',
        }}
      >
        <Stack.Screen name="index" options={{ title: 'Timecards' }} />
        <Stack.Screen name="[employeeId]" options={{ title: 'Employee' }} />
        <Stack.Screen name="[employeeId]/shift" options={{ title: 'Shift' }} />
      </Stack>
    </TimecardsProvider>
  );
}
