import type { ExpoConfig } from 'expo/config';

/**
 * iOS bundle ID — must match the app you create in App Store Connect.
 * Change only if you already registered a different bundle ID in Apple Developer.
 */
const IOS_BUNDLE_ID = 'com.redpoke.scheduler';
const ANDROID_PACKAGE = 'com.redpoke.scheduler';

const config: ExpoConfig = {
  name: 'Red Poke Scheduler',
  slug: 'gm-callout',
  version: '1.0.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'light',
  newArchEnabled: true,
  scheme: 'gm-callout',
  splash: {
    image: './assets/splash-icon.png',
    resizeMode: 'contain',
    backgroundColor: '#ffffff',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_ID,
    buildNumber: '1',
    config: {
      usesNonExemptEncryption: false,
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: [],
    },
  },
  android: {
    package: ANDROID_PACKAGE,
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    '@react-native-community/datetimepicker',
    [
      'expo-build-properties',
      {
        ios: { deploymentTarget: '15.1' },
        android: { minSdkVersion: 24 },
      },
    ],
  ],
  extra: {
    eas: {
      // Filled automatically when you run: cd mobile && eas init
      projectId: process.env.EAS_PROJECT_ID,
    },
  },
  owner: undefined,
};

export default config;
