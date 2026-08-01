import type { ErrorBoundaryProps } from 'expo-router';
import { MessagesScreen } from '../../components/MessagesScreen';
import { RouteErrorFallback } from '../../components/RouteErrorFallback';

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return <RouteErrorFallback error={error} retry={retry} />;
}

export default function ManagerMessages() {
  return <MessagesScreen />;
}
