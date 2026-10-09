import Constants from 'expo-constants'

/** `EXPO_PUBLIC_DEMO=1`: sample data from the Figma file, no relay, nothing stored (screenshots, demos). */
export const DEMO = process.env.EXPO_PUBLIC_DEMO === '1'

export const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0'
