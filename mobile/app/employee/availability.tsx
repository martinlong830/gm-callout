import type { ErrorBoundaryProps } from 'expo-router';
import { AvailabilityScreen } from '../../components/AvailabilityScreen';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';
import { useAppData } from '../../contexts/AppDataContext';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function EmployeeAvailability() {
  const { myEmployee } = useAppData();
  return <AvailabilityScreen mode="employee" selfEmployee={myEmployee} />;
}
