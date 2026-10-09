import type { ConfigContext, ExpoConfig } from 'expo/config'

/**
 * The bundle id / package can be changed for a personal signing team (a free Apple ID cannot
 * register an id someone else already uses): `HUNTGRY_BUNDLE_ID=com.you.huntgry npx expo run:ios`.
 */
const BUNDLE_ID = process.env.HUNTGRY_BUNDLE_ID ?? 'com.huntgry.remote'

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Huntgry',
  slug: 'huntgry',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  // huntgry://pair?v=1&… (the desktop's pairing QR) opens the Pair screen.
  scheme: 'huntgry',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    supportsTablet: false,
    infoPlist: {
      NSCameraUsageDescription: 'Huntgry uses the camera only to scan the pairing code your Mac shows.'
    }
  },
  android: {
    package: BUNDLE_ID,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#07090D'
    },
    permissions: ['android.permission.CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO']
  },
  web: {
    output: 'single',
    favicon: './assets/favicon.png'
  },
  plugins: [
    'expo-router',
    ['expo-camera', { cameraPermission: 'Huntgry uses the camera only to scan the pairing code your Mac shows.', microphonePermission: false, recordAudioAndroid: false }],
    'expo-secure-store',
    'expo-font',
    [
      'expo-splash-screen',
      {
        image: './assets/splash-icon.png',
        imageWidth: 88,
        backgroundColor: '#FBFAF7',
        dark: { image: './assets/splash-icon.png', backgroundColor: '#07090D' }
      }
    ]
  ],
  experiments: {
    typedRoutes: true,
    // tsconfig `paths` are for the type checker only (they pin React's types); Metro resolves
    // React itself in metro.config.js and must not follow a path into @types/react.
    tsconfigPaths: false
  }
})
