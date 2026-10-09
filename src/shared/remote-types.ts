/**
 * Remote control (ADR-0001, #36, #37): what the Settings page sees of the desktop's relay
 * session, its paired phones and pairing requests. The renderer sends only ids, booleans, text
 * fields, numbers and URLs; secrets (the admin token once saved, the owner secret, pairing
 * secrets, relay tokens), keys and paths never come back over IPC. The one exception, by
 * necessity, is the pairing QR: `startPairing` returns it as a rendered image (never its text,
 * and never in the `remote:state` broadcast).
 * The wire contract with the phone is `@shared/remote` (`@huntgry/remote-protocol`).
 */

import type { NotificationCategory } from './remote/protocol'

export type RemoteConnection =
  /** Remote control is off (the default). */
  | 'disabled'
  /** No relay URL / admin token saved yet. */
  | 'unconfigured'
  /** `relay.json` exists but cannot be decrypted (Keychain reset, `userData` copied); re-enter the admin token to recover. */
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
  /** `https://` relay URL, when configured (the admin token is never sent back). */
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
  /** How long a command may wait for this Mac before the gateway refuses it (defaults 2 h / 24 h). */
  commandTtl: RemoteCommandTtl
  devices: RemoteDeviceInfo[]
  /** Pairing codes shown since the app started and the requests they drew, newest first. */
  pairings: RemotePairingInfo[]
}

export interface RemoteCommandTtl {
  /** `queue.enqueue`, `run.reply`, `pipeline.start`, `review.approve`, `review.rerun`. */
  costlySeconds: number
  defaultSeconds: number
}

export interface RemoteDeviceInfo {
  id: string
  name: string
  pairedAt: string
  /** ISO of the last frame received from this device, if any. */
  lastSeen?: string
  /** The phone's counter rewound (reinstall, restore) or the relay credentials were rotated: it must pair again. */
  needsRepair: boolean
  categories: NotificationCategory[]
}

export type RemotePairingStatus =
  /** The QR is up; no phone has answered yet. */
  | 'waiting'
  /** A phone sent `pair.hello`: "Pair '<device name>'?" waits for Approve / Deny. */
  | 'scanned'
  | 'approving'
  | 'paired'
  | 'denied'
  /** The QR, or the time to decide, ran out. */
  | 'expired'

export interface RemotePairingInfo {
  id: string
  status: RemotePairingStatus
  /** ISO: a `pair.hello` after this is refused. */
  expiresAt: string
  /** ISO: a scanned request must be approved before this (the relay's pairing expiry). */
  decideBy: string
  /** From the phone's `pair.hello`, for the approve dialog. */
  deviceName?: string
  appVersion?: string
  /** Why the last Approve failed (the request stays open) or why it was refused. */
  error?: string
}

/** What `startPairing` returns: the QR rendered in main as an SVG data URL; its text, which carries the secret, never crosses IPC. */
export interface RemotePairingStart {
  pairingId: string
  expiresAt: string
  qrDataUrl: string
}

export interface RemoteAuditEntry {
  ts: string
  deviceId: string
  /** The device's name, or "Removed phone". */
  device: string
  command: string
  /** `started`: the write-ahead entry without an outcome (interrupted). */
  outcome: 'ok' | 'failed' | 'started'
  /** `EnvelopeError` code and message of a failure. */
  error?: string
}

export interface RemoteApi {
  state(): Promise<RemoteState>
  /** Turns the session on or off; on needs saved credentials. */
  setEnabled(enabled: boolean): Promise<RemoteState>
  /**
   * Saves the relay URL (https only) and the admin token, creates the room and connects. With
   * credentials already saved, or unreadable, it replaces the room: every phone must pair again.
   */
  configure(input: { relayUrl: string; adminToken: string }): Promise<RemoteState>
  /** A new owner secret and room (saved admin token), the old room deleted, every phone marked *needs re-pair*. */
  rotate(): Promise<RemoteState>
  setNotificationDetails(on: boolean): Promise<RemoteState>
  setTranscripts(on: boolean): Promise<RemoteState>
  setCommandTtl(input: RemoteCommandTtl): Promise<RemoteState>
  /** Deletes the device's key locally and its token on the relay; tells the phone if connected. */
  revoke(deviceId: string): Promise<RemoteState>
  /** Revokes every device and rotates the desktop keypair and the relay credentials. */
  unpairAll(): Promise<RemoteState>
  /** A fresh one-time pairing code, valid 2 minutes; withdraws a code nobody scanned. */
  startPairing(): Promise<RemotePairingStart>
  /** Withdraws a code nobody scanned (the modal closed); a scanned request stays until decided or expired. */
  cancelPairing(pairingId: string): Promise<RemoteState>
  approvePairing(pairingId: string): Promise<RemoteState>
  denyPairing(pairingId: string): Promise<RemoteState>
  /** The last 200 remote commands of the open workspace, newest first. */
  audit(): Promise<RemoteAuditEntry[]>
}

export const REMOTE_CHANNELS = {
  state: 'remote:get-state',
  setEnabled: 'remote:set-enabled',
  configure: 'remote:configure',
  rotate: 'remote:rotate',
  setNotificationDetails: 'remote:set-notification-details',
  setTranscripts: 'remote:set-transcripts',
  setCommandTtl: 'remote:set-command-ttl',
  revoke: 'remote:revoke',
  unpairAll: 'remote:unpair-all',
  startPairing: 'remote:start-pairing',
  cancelPairing: 'remote:cancel-pairing',
  approvePairing: 'remote:approve-pairing',
  denyPairing: 'remote:deny-pairing',
  audit: 'remote:audit'
} as const

export interface RemoteEvents {
  /** The session's state changed (connected, dropped, credentials unreadable, a device revoked, a phone scanned a code). */
  'remote:state': RemoteState
}
