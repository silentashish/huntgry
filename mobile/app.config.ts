import type { ConfigContext, ExpoConfig } from 'expo/config'
import { withEntitlementsPlist, type ConfigPlugin } from 'expo/config-plugins'
import pkg from './package.json'

/**
 * The bundle id / package can be changed for a personal signing team (a free Apple ID cannot
 * register an id someone else already uses): `HUNTGRY_BUNDLE_ID=com.you.huntgry npx expo run:ios`.
 */
const BUNDLE_ID = process.env.HUNTGRY_BUNDLE_ID ?? 'com.huntgry.remote'

/**
 * The EAS project id (`eas init` prints it). Push tokens need it; nothing else does. Read from
 * the environment so no account-specific id is committed: `.env` / the shell locally, an EAS
 * environment variable or `--env` for cloud builds (see RELEASE.md).
 */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID || undefined

/**
 * Push (#39) adds the `aps-environment` entitlement, which a free Apple ID's personal team
 * cannot sign. `HUNTGRY_PUSH=0 npx expo run:ios --device` builds without it (no push, as in #38).
 */
const PUSH = process.env.HUNTGRY_PUSH !== '0'

/**
 * Every EAS build is signed for distribution (ad hoc or App Store), whose profiles carry the
 * production APNs environment; EAS sets `EAS_BUILD_PROFILE` while it resolves this config. Local
 * `expo run:ios` builds are development-signed and use the APNs sandbox.
 */
const APNS_MODE: 'development' | 'production' = process.env.EAS_BUILD_PROFILE ? 'production' : 'development'

/** Android: `google-services.json` (FCM, for push) as an EAS file environment variable or a local path. Never committed. */
const GOOGLE_SERVICES_FILE = process.env.GOOGLE_SERVICES_JSON || undefined

/**
 * Versions. `version` (CFBundleShortVersionString / versionName) comes from package.json and is
 * bumped by hand per release. Build numbers (`ios.buildNumber`, `android.versionCode`) belong to
 * EAS: `eas.json` sets `appVersionSource: "remote"` and `autoIncrement` on the store profiles, so
 * the values below only apply to local `expo run:*` builds.
 */
const VERSION = pkg.version

const CAMERA_TEXT = 'Huntgry uses the camera only to scan the pairing code your Mac shows.'

/**
 * Removes the push entitlement again. Applied to the config before the `plugins` list: mods run
 * in reverse order of registration, so this one sees the entitlements after expo-notifications.
 */
const withoutPushEntitlement: ConfigPlugin = (config) =>
  withEntitlementsPlist(config, (c) => {
    delete c.modResults['aps-environment']
    return c
  })

export default ({ config }: ConfigContext): ExpoConfig => {
  const app = appConfig(config)
  return PUSH ? app : withoutPushEntitlement(app)
}

const appConfig = (config: ConfigContext['config']): ExpoConfig => ({
  ...config,
  name: 'Huntgry',
  slug: 'huntgry',
  ...(process.env.EXPO_OWNER ? { owner: process.env.EXPO_OWNER } : {}),
  version: VERSION,
  // Same JS + same version = same native build; OTA updates are not used (no expo-updates).
  runtimeVersion: { policy: 'appVersion' },
  orientation: 'portrait',
  icon: './assets/icon.png',
  // huntgry://pair?v=1&… (the desktop's pairing QR) opens the Pair screen.
  scheme: 'huntgry',
  userInterfaceStyle: 'automatic',
  ios: {
    bundleIdentifier: BUNDLE_ID,
    buildNumber: '1',
    supportsTablet: false,
    infoPlist: {
      NSCameraUsageDescription: CAMERA_TEXT,
      // Only standard HTTPS/TLS (tweetnacl is not export-controlled encryption): skips the export question in App Store Connect.
      ITSAppUsesNonExemptEncryption: false
    }
    // No UIBackgroundModes: pushes are plain alerts; nothing runs in the background.
  },
  android: {
    package: BUNDLE_ID,
    versionCode: 1,
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      monochromeImage: './assets/monochrome-icon.png',
      backgroundColor: '#07090D'
    },
    ...(GOOGLE_SERVICES_FILE ? { googleServicesFile: GOOGLE_SERVICES_FILE } : {}),
    // POST_NOTIFICATIONS (Android 13+) comes from expo-notifications.
    permissions: ['android.permission.CAMERA'],
    blockedPermissions: ['android.permission.RECORD_AUDIO']
  },
  web: {
    output: 'single',
    favicon: './assets/favicon.png'
  },
  plugins: [
    'expo-router',
    ['expo-camera', { cameraPermission: CAMERA_TEXT, microphonePermission: false, recordAudioAndroid: false }],
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
    ],
    [
      'expo-notifications',
      {
        // Android status bar: the paw, white on transparent (Android tints it with `color`).
        icon: './assets/notification-icon.png',
        color: '#E66E0A',
        mode: APNS_MODE,
        // Alerts only: no silent background pushes, so no `remote-notification` background mode.
        enableBackgroundRemoteNotifications: false
      }
    ]
  ],
  extra: {
    ...config.extra,
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {})
  },
  experiments: {
    typedRoutes: true,
    // tsconfig `paths` are for the type checker only (they pin React's types); Metro resolves
    // React itself in metro.config.js and must not follow a path into @types/react.
    tsconfigPaths: false
  }
})
