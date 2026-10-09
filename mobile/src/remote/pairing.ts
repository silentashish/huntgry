/**
 * Pairing from the phone (ADR-0001, "Pairing"; the wire format is the protocol package's
 * `pairing.ts`):
 *
 * 1. `parsePairingUrl` reads the QR (or a pasted / deep-linked `huntgry://pair?…`): an
 *    `https://` relay only, `expired` after `exp`.
 * 2. A fresh device keypair goes into the secure store.
 * 3. `wss://…/ws`, first frame `{ auth: { room, pairing } }`; after the relay's presence notice,
 *    `RelayFrame{ to: 'desktop', ref, ...sealPairMessage({ pair: 'hello', hello }, S), ttl: 120 }`.
 * 4. Waiting for approval on the Mac. The answer is a frame addressed to the pairing id:
 *    `ok` sealed with `sessionKey = deriveSessionKey(desktopPub, devicePriv)` → `{ ack: ref }`,
 *    close, everything stored; `denied` sealed with `S` → denied (or expired).
 * 5. The relay closes the pairing socket at `exp` (4006): the code expired.
 */

import {
  NOTIFICATION_CATEGORIES,
  PAIRING_TTL_SECONDS,
  PROTOCOL,
  ProtocolError,
  RELAY_PATHS,
  deriveSessionKey,
  negotiateProtocol,
  openPairMessage,
  parsePairingUrl,
  requireRelayClientFrame,
  requireRelayFrame,
  requireRelayNotice,
  sealPairMessage,
  toBase64,
  toHex,
  type PairingInvite,
  type PairMessage,
  type PairOk,
  type RelayFrame,
  type Sealed
} from '@huntgry/remote-protocol'
import { socketUrl, uuid } from './ids'
import { CLOSE_CODES } from './relay'
import { systemClock, type Clock, type SocketFactory, type SocketLike } from './platform'
import type { Pairing, Vault } from './vault'

export type PairingStep =
  | { step: 'idle' }
  /** Opening the relay socket. */
  | { step: 'connecting'; invite: PairingInvite }
  /** `pair.hello` sent; the owner approves on the Mac. `queued`: the Mac is not connected to the relay right now. */
  | { step: 'waiting'; invite: PairingInvite; queued: boolean }
  | { step: 'paired'; pairing: Pairing }
  | { step: 'denied' }
  /** The QR's two minutes ran out (before scanning, or while waiting). */
  | { step: 'expired' }
  | { step: 'error'; message: string }

/**
 * The desktop's answer to `pair.hello`: `ok` sealed with the session key
 * (`deriveSessionKey(desktopPub, devicePriv)`), so someone who saw the QR cannot read the relay
 * token; `denied` sealed with the QR secret S (the desktop has no session key for a phone it
 * refused). Anything else is refused. Same rules as the protocol package's `openPairReply` (#37);
 * kept here until that lands on this branch.
 */
export function openPairReply(sealed: Sealed, keys: { secret: Uint8Array; sessionKey: Uint8Array }): PairMessage | null {
  const underSession = openPairMessage(sealed, keys.sessionKey)
  if (underSession) {
    if (underSession.pair !== 'ok') throw new ProtocolError('invalid', 'Only pair.ok is sealed with the session key.')
    return underSession
  }
  const underSecret = openPairMessage(sealed, keys.secret)
  if (underSecret) {
    if (underSecret.pair !== 'denied') throw new ProtocolError('invalid', 'Only pair.denied is sealed with the pairing secret.')
    return underSecret
  }
  return null
}

export interface PairingDeps {
  vault: Vault
  socket: SocketFactory
  appVersion: string
  deviceName: string
  clock?: Clock
  onStep?(step: PairingStep): void
}

export class PairingError extends Error {
  constructor(readonly step: Extract<PairingStep, { step: 'denied' | 'expired' | 'error' }>) {
    super(step.step === 'error' ? step.message : step.step)
    this.name = 'PairingError'
  }
}

/** One pairing attempt. `start` resolves with the stored pairing or rejects with a `PairingError`. */
export class PairingFlow {
  private socket: SocketLike | null = null
  private settled = false
  private timer: unknown = null
  private readonly clock: Clock
  private resolve!: (p: Pairing) => void
  private reject!: (e: PairingError) => void

  constructor(private readonly deps: PairingDeps) {
    this.clock = deps.clock ?? systemClock
  }

  start(qrText: string): Promise<Pairing> {
    const done = new Promise<Pairing>((resolve, reject) => {
      this.resolve = resolve
      this.reject = reject
    })
    let invite: PairingInvite
    try {
      invite = parsePairingUrl(qrText.trim(), this.clock.now())
    } catch (err) {
      if (err instanceof ProtocolError && err.code === 'expired') this.fail({ step: 'expired' })
      else this.fail({ step: 'error', message: err instanceof Error ? err.message : 'This is not a Huntgry pairing code.' })
      return done
    }
    void this.run(invite)
    return done
  }

  cancel(): void {
    this.fail({ step: 'error', message: 'Pairing cancelled.' })
  }

  private step(step: PairingStep): void {
    if (!this.settled) this.deps.onStep?.(step)
  }

  private fail(step: Extract<PairingStep, { step: 'denied' | 'expired' | 'error' }>): void {
    if (this.settled) return
    this.settled = true
    this.cleanup()
    this.deps.onStep?.(step)
    this.reject(new PairingError(step))
  }

  private cleanup(): void {
    if (this.timer !== null) this.clock.clearTimeout(this.timer)
    this.timer = null
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(1000, 'pairing done')
    } catch {
      // already closed
    }
  }

  private async run(invite: PairingInvite): Promise<void> {
    this.step({ step: 'connecting', invite })
    // Any earlier pairing is gone once this phone pairs again; a new identity for a new pairing.
    await this.deps.vault.wipe()
    const identity = await this.deps.vault.createIdentity()
    if (this.settled) return
    // Known before the hello leaves: the desktop seals `pair.ok` with it, so only this phone reads the relay token.
    const sessionKey = deriveSessionKey(invite.desktopPublicKey, identity.secretKey)
    const ref = uuid()
    const hello = sealPairMessage(
      { pair: 'hello', hello: { devicePub: toBase64(identity.publicKey), deviceName: this.deps.deviceName, appVersion: this.deps.appVersion, protocol: { ...PROTOCOL } } },
      invite.secret
    )
    const helloFrame: RelayFrame = requireRelayFrame({ to: 'desktop', ref, ...hello, ttl: PAIRING_TTL_SECONDS })

    // The relay closes the pairing socket at exp; this covers a socket that never got that far.
    const left = Math.max(0, invite.exp * 1000 - this.clock.now())
    this.timer = this.clock.setTimeout(() => this.fail({ step: 'expired' }), left + 5_000)

    let socket: SocketLike
    try {
      socket = this.deps.socket(socketUrl(invite.relay, RELAY_PATHS.socket))
    } catch {
      this.fail({ step: 'error', message: 'Could not reach the relay.' })
      return
    }
    this.socket = socket
    let helloSent = false
    socket.onopen = () => {
      socket.send(JSON.stringify(requireRelayClientFrame({ auth: { room: invite.room, pairing: invite.pairing } })))
    }
    socket.onclose = (event) => {
      if (this.settled) return
      if (event.code === CLOSE_CODES.pairingExpired) this.fail({ step: 'expired' })
      else if (event.code === CLOSE_CODES.unauthorized) this.fail({ step: 'expired' }) // pairing id unknown: used or expired on the Mac
      else this.fail({ step: 'error', message: 'Lost the connection to the relay. Show a new code on your Mac and try again.' })
    }
    socket.onerror = () => undefined
    socket.onmessage = (event) => {
      if (this.settled || typeof event.data !== 'string') return
      let raw: unknown
      try {
        raw = JSON.parse(event.data)
      } catch {
        return
      }
      if (typeof raw !== 'object' || raw === null) return
      if (!('ct' in raw)) {
        let notice
        try {
          notice = requireRelayNotice(raw)
        } catch {
          return
        }
        if ('presence' in notice) {
          // The relay accepted the auth frame (presence comes first): now the hello.
          if (!helloSent) {
            helloSent = true
            socket.send(JSON.stringify(helloFrame))
          }
          this.step({ step: 'waiting', invite, queued: notice.presence === 'offline' })
        } else if ('queued' in notice && notice.ref === ref) {
          this.step({ step: 'waiting', invite, queued: true })
        } else if ('expired' in notice && notice.ref === ref) {
          this.fail({ step: 'expired' })
        }
        return
      }
      let frame: RelayFrame
      try {
        frame = requireRelayFrame(raw)
      } catch {
        return
      }
      let message: PairMessage | null
      try {
        message = openPairReply(frame, { secret: invite.secret, sessionKey })
      } catch {
        message = null // an ok under S or a denied under the session key: not from the desktop
      }
      if (!message || message.pair === 'hello') return
      socket.send(JSON.stringify(requireRelayClientFrame({ ack: frame.ref })))
      if (message.pair === 'denied') {
        this.fail(message.reason === 'expired' ? { step: 'expired' } : { step: 'denied' })
        return
      }
      void this.finish(invite, sessionKey, message.ok)
    }
  }

  private async finish(invite: PairingInvite, sessionKey: Uint8Array, ok: PairOk): Promise<void> {
    try {
      negotiateProtocol(ok.protocol)
    } catch {
      this.fail({ step: 'error', message: 'Your Mac runs a Huntgry this app cannot talk to. Update both.' })
      return
    }
    const pairing: Pairing = {
      relay: invite.relay,
      room: invite.room,
      deviceId: ok.deviceId,
      relayToken: ok.relayToken,
      desktopPublicKey: toHex(invite.desktopPublicKey),
      sessionKey: toBase64(sessionKey),
      sid: ok.sid,
      desktopName: ok.desktopName,
      deviceName: this.deps.deviceName,
      pairedAt: new Date(this.clock.now()).toISOString(),
      categories: [...NOTIFICATION_CATEGORIES]
    }
    try {
      await this.deps.vault.savePairing(pairing)
    } catch {
      this.fail({ step: 'error', message: 'Could not save the pairing on this phone.' })
      return
    }
    if (this.settled) return
    this.settled = true
    this.cleanup()
    this.deps.onStep?.({ step: 'paired', pairing })
    this.resolve(pairing)
  }
}
