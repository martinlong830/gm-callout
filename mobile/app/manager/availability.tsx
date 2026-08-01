import type { ErrorBoundaryProps } from 'expo-router';
import { AvailabilityScreen } from '../../components/AvailabilityScreen';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function ManagerAvailability() {
  return <AvailabilityScreen mode="manager" />;
}
