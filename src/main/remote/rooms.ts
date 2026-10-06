import type { RelayCredentials } from './credentials'

/**
 * Room rotation for Settings (ADR-0001, "Relay deployment / credential storage"): Rotate in
 * the relay form and Unpair everything. Electron-free so the control flow is tested: the warning
 * a failed relay revocation leaves is cleared by any rotation (the old room and its tokens
 * are gone), and Unpair everything always reconnects, even when the relay refuses a new room.
 */

export interface RoomDeps {
  /** Creates a room for a new owner secret. */
  createRoom(relayUrl: string, adminToken: string): Promise<RelayCredentials>
  /**
   * Deletes a replaced room (best effort, never throws). Called only once the new credentials are
   * on disk: deleted first, a failed write would leave relay.json naming a room that is gone.
   */
  deleteRoom(old: RelayCredentials): Promise<void>
  writeCredentials(credentials: RelayCredentials): Promise<void>
  /** New desktop identity; every paired device is dropped. */
  rotateKeyPair(): Promise<unknown>
  stopSession(): void
  /** Re-reads the credentials and settings and connects (or stays closed), publishing the state. */
  apply(): Promise<unknown>
}

export const REVOKE_UNCONFIRMED =
  'A removed phone is refused by this Mac, but the relay did not confirm deleting its token. Use Unpair everything once the relay is reachable to rotate the room.'

export class RoomControl {
  private warning: string | null = null

  constructor(private deps: RoomDeps) {}

  /** Shown in Settings until a rotation replaces the room. */
  revokeWarning(): string | null {
    return this.warning
  }

  relayDidNotConfirmRevoke(): void {
    this.warning = REVOKE_UNCONFIRMED
  }

  /** The relay form's Save / Rotate: a new room; replacing one also rotates the desktop key. */
  async replaceRoom(relayUrl: string, adminToken: string, previous: RelayCredentials | null): Promise<void> {
    const next = await this.deps.createRoom(relayUrl, adminToken)
    await this.deps.writeCredentials(next)
    if (previous) {
      await this.deps.deleteRoom(previous)
      await this.deps.rotateKeyPair()
      // The old room, and every token a failed revocation left in it, is gone.
      this.warning = null
    }
  }

  /**
   * Unpair everything, after the devices were revoked: a new desktop key and, with credentials,
   * a new room. `apply` runs whatever happens, so a relay that refuses the new room leaves the
   * session reconnected to the old one (and the warning up), and the error reaches the caller.
   */
  async rotateAll(current: RelayCredentials | null): Promise<void> {
    await this.deps.rotateKeyPair()
    if (!current) {
      await this.deps.apply()
      return
    }
    this.deps.stopSession()
    try {
      await this.deps.writeCredentials(await this.deps.createRoom(current.relayUrl, current.adminToken))
      await this.deps.deleteRoom(current)
      this.warning = null
    } finally {
      await this.deps.apply()
    }
  }
}
