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
    [
      'expo-notifications',
      {
        icon: './assets/icon.png',
        color: '#c41230',
      },
    ],
  ],
  ios: {
    supportsTablet: true,
    bundleIdentifier: IOS_BUNDLE_ID,
    buildNumber: '1',
    config: {
      usesNonExemptEncryption: false,
    },
    // Required for expo-notifications; production App Store builds use "production".
    // Regenerating the App Store provisioning profile must include Push Notifications
    // so this entitlement is covered (see EAS credentials / Apple Developer App ID).
    entitlements: {
      'aps-environment': 'production',
    },
    infoPlist: {
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: ['remote-notification'],
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
  extra: {
    eas: {
      projectId: '4e08651a-f13a-4ebd-99e9-96ea3451a0bb',
    },
  },
  owner: undefined,
};

export default config;
