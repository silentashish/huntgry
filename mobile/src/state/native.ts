import * as Device from 'expo-device'
import * as SecureStore from 'expo-secure-store'
import { Platform } from 'react-native'
import { MemoryStorage, type SecureStorage, type SocketFactory, type SocketLike } from '../remote/platform'

/**
 * The keychain (iOS) / Keystore-backed SharedPreferences (Android). Keys stay on this device
 * only (no iCloud keychain sync, no backup restore onto another phone) and are readable after
 * the first unlock, so a reconnect in the background works.
 */
const secureStore: SecureStorage = {
  getItem: (key) => SecureStore.getItemAsync(key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  setItem: (key, value) => SecureStore.setItemAsync(key, value, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY }),
  deleteItem: (key) => SecureStore.deleteItemAsync(key, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY })
}

/** expo-secure-store has no web implementation: the web build (development only) keeps nothing. */
export const storage: SecureStorage = Platform.OS === 'web' ? new MemoryStorage() : secureStore

/** React Native's WebSocket; the URL never carries a credential (first-frame auth). */
export const socketFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike

/** What the phone calls itself in `pair.hello` until the owner renames it in Settings. */
export function defaultDeviceName(): string {
  return (Device.deviceName ?? Device.modelName ?? (Platform.OS === 'ios' ? 'iPhone' : 'Phone')).slice(0, 64)
}
