/**
 * Remote control (ADR-0001, #36): what the Settings page sees of the desktop's relay
 * session. Pairing (QR, approve) is #37; this API only enables the session, stores the
 * relay credentials, lists devices, revokes them and reports the session's state.
 * The wire contract with the phone is `@shared/remote` (`@huntgry/remote-protocol`).
 */

import type { NotificationCategory } from './remote/protocol'

export type RemoteConnection =
  /** Remote control is off (the default). */
  | 'disabled'
  /** No relay URL / admin token saved yet. */
  | 'unconfigured'
  /** `relay.json` exists but cannot be decrypted (Keychain reset, `userData` copied); rotate credentials to recover (#37). */
  | 'credentials-unreadable'
  /** Enabled, socket not open (relay unreachable, backing off). */
  | 'offline'
  | 'connecting'
  /** Socket open and authenticated to the room. */
  | 'online'

export interface RemoteState {
  connection: RemoteConnection
  /** Set for `offline` and `credentials-unreadable`: what happened, for the Settings page. */
  error?: string
  /** `https://` relay URL, when configured. */
  relayUrl?: string
  roomId?: string
  /** ISO of the last successful authentication. */
  onlineSince?: string
  /** ISO of the next reconnect attempt while `offline`. */
  nextAttemptAt?: string
  /** `pushText` on notifications (default off). */
  notificationDetails: boolean
  /** Transcripts may be fetched with `run.get` (default on). */
  transcripts: boolean
  devices: RemoteDeviceInfo[]
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  pairedAt: string
  /** ISO of the last frame received from this device, if any. */
  lastSeen?: string
  /** The phone's counter rewound (reinstall, restore); it must be paired again. */
  needsRepair: boolean
  categories: NotificationCategory[]
}

export interface RemoteApi {
  state(): Promise<RemoteState>
  /** Turns the session on or off; on needs saved credentials. */
  setEnabled(enabled: boolean): Promise<RemoteState>
  /**
   * Saves the relay URL (https only) and the admin token, creates the room and connects.
   * Rotates the owner secret and the room when credentials already exist (every phone pairs again).
   */
  configure(input: { relayUrl: string; adminToken: string }): Promise<RemoteState>
  setNotificationDetails(on: boolean): Promise<RemoteState>
  setTranscripts(on: boolean): Promise<RemoteState>
  /** Deletes the device's key locally and its token on the relay; tells the phone if connected. */
  revoke(deviceId: string): Promise<RemoteState>
  /** Revokes every device and rotates the desktop keypair and the relay credentials. */
  unpairAll(): Promise<RemoteState>
}

export const REMOTE_CHANNELS = {
  state: 'remote:get-state',
  setEnabled: 'remote:set-enabled',
  configure: 'remote:configure',
  setNotificationDetails: 'remote:set-notification-details',
  setTranscripts: 'remote:set-transcripts',
  revoke: 'remote:revoke',
  unpairAll: 'remote:unpair-all'
} as const

export interface RemoteEvents {
  /** The session's state changed (connected, dropped, credentials unreadable, a device revoked). */
  'remote:state': RemoteState
}
