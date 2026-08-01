import React from 'react';
import { RouteErrorFallback } from './RouteErrorFallback';

type Props = { children: React.ReactNode };

type State = { hasError: boolean; error: Error | null };

/**
 * Last-resort boundary around providers. Prefer route-level ErrorBoundary exports
 * so a single tab failure does not blank the whole app.
 */
export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: unknown) {
    console.warn('RootErrorBoundary', error);
  }

  private retry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <RouteErrorFallback
          error={this.state.error || new Error('Unknown error')}
          retry={this.retry}
        />
      );
    }
    return this.props.children;
  }
}
