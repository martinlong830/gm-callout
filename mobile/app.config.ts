import type { ExpoConfig } from 'expo/config';

/**
 * iOS bundle ID — must match the app you create in App Store Connect.
 * Change only if you already registered a different bundle ID in Apple Developer.
 */
const IOS_BUNDLE_ID = 'com.shiflow.app';
const ANDROID_PACKAGE = 'com.shiflow.app';

const config: ExpoConfig = {
  name: 'Shiflow',
  slug: 'gm-callout',
  version: '1.0.1',
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
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#1e3a5f',
    },
    edgeToEdgeEnabled: true,
  },
  web: {
    favicon: './assets/favicon.png',
  },
  plugins: [
    'expo-router',
    [
      'expo-image-picker',
      {
        photosPermission:
          'Allow access to your photo library to set employee profile pictures.',
      },
    ],
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
      projectId: '4e08651a-f13a-4ebd-99e9-96ea3451a0bb',
    },
  },
  owner: undefined,
};

export default config;
