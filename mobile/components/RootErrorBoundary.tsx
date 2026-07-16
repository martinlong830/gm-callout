import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

type Props = { children: React.ReactNode };

type State = { hasError: boolean };

/**
 * Prevents a provider/render failure from taking down the entire native process
 * before the login screen can appear.
 */
export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('RootErrorBoundary', error);
  }

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title}>Something went wrong</Text>
          <Text style={styles.body}>Force-quit and reopen Shiflow. If this keeps happening, reinstall the app.</Text>
        </View>
      );
    }
    return this.props.children;
  }
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
});
