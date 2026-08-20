import { Image, StyleSheet } from 'react-native';

/** Red Poke mark for the fixed tab header (top-left, does not scroll). */
export function BrandLogoHeader() {
  return (
    <Image
      source={require('../assets/red-poke-logo.png')}
      style={styles.logo}
      accessibilityLabel="Red Poke"
    />
  );
}

const styles = StyleSheet.create({
  logo: {
    width: 36,
    height: 36,
    resizeMode: 'contain',
    marginLeft: 4,
  },
});
