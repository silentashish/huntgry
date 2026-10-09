import { createHash, randomUUID } from 'node:crypto'
import { renderSVG } from 'uqr'
import {
  LIMITS,
  PAIRING_TTL_SECONDS,
  PROTOCOL,
  SECRET_BYTES,
  negotiateProtocol,
  openPairMessage,
  pairingUrl,
  randomBytes,
  sealPairMessage,
  toHex,
  type PairHello,
  type PairMessage,
  type RelayFrame
} from '@shared/remote'
import type { RemotePairingInfo, RemotePairingStart } from '@shared/remote-types'
import type { DeviceRecord, DeviceStore } from './devices'

/**
 * Pairing a phone (ADR-0001, "Pairing"; #37). Electron-free: the relay calls, the socket and the
 * QR renderer are injected, so the whole exchange is tested against a fake relay.
 *
 * 1. `start()` makes a one-time secret `S` (32 random bytes), a `pairingId` and `exp` = now +
 *    `PAIRING_TTL_SECONDS`, registers the pairing on the relay (`POST /rooms/{room}/pairings`)
 *    and renders the QR (`pairingUrl`) to an SVG image. The QR text never leaves this module.
 * 2. `receive(frame)` is called by the session for a frame no paired device's key opens: it tries
 *    each open secret, the way the session tries each session key. The first `pair.hello` before
 *    `exp` consumes the secret and waits for the owner ("Pair '<device name>'?"); a second hello,
 *    or one after `exp`, is answered `{ pair: 'denied', reason: 'expired' }` (a second hello while
 *    the first still waits is ignored, so it cannot replace the request being shown).
 * 3. `approve()` mints `deviceId`, `relayToken` (32 random bytes, hex) and `sid`, registers
 *    `{ deviceId, sha256(relayToken) }` on the relay, writes the device record, and only then
 *    sends `pair.ok`. `deny()` sends `pair.denied` and keeps nothing.
 *
 * The relay is told the pairing lives `APPROVAL_SECONDS` longer than the QR, so the phone's
 * pairing socket (closed by the relay at its `exp`, code 4006) stays open while the owner
 * decides; a request not decided by then is dropped.
 */

/** Time to Approve / Deny after the QR expired; QR + this stays within the relay's 10 min cap. */
export const APPROVAL_SECONDS = 5 * 60

/** `RelayFrame.ttl` of the desktop's pairing answers. */
const PAIR_FRAME_TTL = 120

export interface PairingDeps {
  devices: Pick<DeviceStore, 'keyPair' | 'add' | 'remove'>
  /** The relay URL and room of the saved credentials; `null` while not set up. */
  relay(): { relayUrl: string; roomId: string } | null
  /** `POST /rooms/{room}/pairings`. */
  registerPairing(pairingId: string, exp: string): Promise<void>
  /** `POST /rooms/{room}/devices`. */
  registerDevice(deviceId: string, tokenHash: string): Promise<void>
  /** `DELETE /rooms/{room}/devices/{id}` when `pair.ok` could not be sent (best effort). */
  unregisterDevice(deviceId: string): Promise<void>
  /** Sends a relay frame on the desktop's socket; `false` when it is not connected. */
  send(frame: RelayFrame): Promise<boolean>
  /** `{ ack: ref }` for a processed frame. */
  ack(ref: string): Promise<void>
  online(): boolean
  desktopName: string
  /** Renders the QR text to an image URL (default: SVG data URL). */
  renderQr?(text: string): string
  /** A request arrived, was decided or expired (publish `remote:state`). */
  onChange?(): void
  now?(): number
}

type Stage = 'waiting' | 'scanned' | 'approving' | 'paired' | 'denied' | 'expired'

interface Pairing {
  id: string
  secret: Uint8Array
  /** Hex of the desktop key the QR carried. */
  desktopKey: string
  /** ms: hello refused after this. */
  exp: number
  /** ms: the relay forgets the pairing; the entry is dropped. */
  relayExp: number
  stage: Stage
  hello?: PairHello
  error?: string
  timer?: NodeJS.Timeout
}

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/** The QR as an SVG data URL: black on white with a quiet zone, medium error correction. */
export function renderQrSvg(text: string): string {
  const svg = renderSVG(text, { ecc: 'M', border: 2, pixelSize: 8 })
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`
}

export class PairingManager {
  private pairings = new Map<string, Pairing>()

  constructor(private deps: PairingDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private changed(): void {
    this.deps.onChange?.()
  }

  /** A new code. Codes nobody scanned are withdrawn (one QR on screen at a time). */
  async start(): Promise<RemotePairingStart> {
    const relay = this.deps.relay()
    if (!relay) throw new Error('Set up the relay first.')
    if (!this.deps.online()) throw new Error('This Mac is not connected to the relay yet. Wait for "Connected", then try again.')
    const keys = await this.deps.devices.keyPair()
    if (!keys) throw new Error('Encrypted storage is not available on this Mac; a phone cannot be paired.')
    for (const p of this.pairings.values()) if (p.stage === 'waiting') this.drop(p.id)
    const now = this.now()
    const id = randomUUID()
    const secret = randomBytes(SECRET_BYTES)
    const expSeconds = Math.floor(now / 1000) + PAIRING_TTL_SECONDS
    const pairing: Pairing = { id, secret, desktopKey: toHex(keys.publicKey), exp: expSeconds * 1000, relayExp: (expSeconds + APPROVAL_SECONDS) * 1000, stage: 'waiting' }
    const text = pairingUrl({ v: 1, relay: relay.relayUrl, room: relay.roomId, pairing: id, desktopPublicKey: keys.publicKey, secret, exp: expSeconds })
    await this.deps.registerPairing(id, new Date(pairing.relayExp).toISOString())
    this.pairings.set(id, pairing)
    this.schedule(pairing)
    this.changed()
    return { pairingId: id, expiresAt: new Date(pairing.exp).toISOString(), qrDataUrl: (this.deps.renderQr ?? renderQrSvg)(text) }
  }

  /** Re-checks the clock at the QR expiry and drops the entry when the relay forgets the pairing. */
  private schedule(p: Pairing): void {
    const tick = () => {
      p.timer = undefined
      if (!this.pairings.has(p.id)) return
      this.sweep()
      if (this.pairings.has(p.id)) this.schedule(p)
      this.changed()
    }
    const now = this.now()
    const next = p.exp > now ? p.exp : p.relayExp
    p.timer = setTimeout(tick, Math.max(0, next - now) + 50)
    p.timer.unref?.()
  }

  /** Expired codes and undecided requests become `expired`; entries the relay forgot are dropped. */
  private sweep(): void {
    const now = this.now()
    for (const p of [...this.pairings.values()]) {
      if (now >= p.relayExp) {
        this.drop(p.id)
        continue
      }
      if (p.stage === 'waiting' && now >= p.exp) p.stage = 'expired'
    }
  }

  private drop(id: string): void {
    const p = this.pairings.get(id)
    if (!p) return
    if (p.timer) clearTimeout(p.timer)
    p.secret.fill(0)
    this.pairings.delete(id)
  }

  /** Every code still known, newest first, for `remote:state` (no secret, no key). */
  list(): RemotePairingInfo[] {
    this.sweep()
    return [...this.pairings.values()].reverse().map((p) => {
      const info: RemotePairingInfo = { id: p.id, status: p.stage, expiresAt: new Date(p.exp).toISOString(), decideBy: new Date(p.relayExp).toISOString() }
      if (p.hello) {
        info.deviceName = p.hello.deviceName
        info.appVersion = p.hello.appVersion
      }
      if (p.error) info.error = p.error
      return info
    })
  }

  /** Withdraws a code nobody scanned; a scanned request stays until it is decided or expires. */
  cancel(id: string): void {
    const p = this.pairings.get(id)
    if (!p || p.stage === 'scanned' || p.stage === 'approving') return
    this.drop(id)
    this.changed()
  }

  /** Forgets every code and request (Unpair everything, rotation: the QR's key or room is gone). */
  cancelAll(): void {
    for (const id of [...this.pairings.keys()]) this.drop(id)
    this.changed()
  }

  /**
   * A frame no paired device's key opened. `true` when one of the open secrets opens it (the
   * frame is then acked and handled here); `false` leaves it to the caller (dropped, unacked).
   */
  async receive(frame: RelayFrame): Promise<boolean> {
    this.sweep()
    for (const p of this.pairings.values()) {
      let message: PairMessage | null
      try {
        message = openPairMessage(frame, p.secret)
      } catch (err) {
        // It opened with this secret but is not a pairing message: consumed, nothing to answer.
        console.warn('[remote] malformed pairing message:', (err as Error).message)
        await this.deps.ack(frame.ref)
        return true
      }
      if (message === null) continue
      await this.deps.ack(frame.ref)
      if (message.pair === 'hello') await this.hello(p, message.hello)
      return true
    }
    return false
  }

  private async hello(p: Pairing, hello: PairHello): Promise<void> {
    if (p.stage === 'scanned' || p.stage === 'approving') {
      // Somebody else with the QR (or the same phone again) while the owner decides: ignored.
      console.warn(`[remote] a second pair.hello for pairing ${p.id} was ignored`)
      return
    }
    if (p.stage !== 'waiting' || this.now() >= p.exp) {
      // The secret was used already, or came too late: refused, whoever sent it.
      if (p.stage === 'waiting') p.stage = 'expired'
      await this.reply(p, { pair: 'denied', reason: 'expired' })
      this.changed()
      return
    }
    try {
      negotiateProtocol(hello.protocol)
    } catch (err) {
      p.stage = 'denied'
      p.hello = hello
      p.error = `This phone's app speaks another protocol version; update it. (${(err as Error).message})`
      await this.reply(p, { pair: 'denied', reason: 'denied' })
      this.changed()
      return
    }
    // The secret is consumed here: from now on this pairing can only be approved or denied.
    p.stage = 'scanned'
    p.hello = hello
    this.changed()
  }

  private async reply(p: Pairing, message: PairMessage): Promise<boolean> {
    const frame: RelayFrame = { to: p.id, ref: randomUUID(), ...sealPairMessage(message, p.secret), ttl: PAIR_FRAME_TTL }
    return this.deps.send(frame)
  }

  private waiting(id: string): Pairing {
    this.sweep()
    const p = this.pairings.get(id)
    if (!p || p.stage !== 'scanned' || !p.hello) throw new Error('This pairing request is no longer waiting. Show a new code on this Mac.')
    return p
  }

  /**
   * Approve: registration on the relay, then the device record, then `pair.ok`. Nothing is
   * written before the relay accepted the token; if `pair.ok` cannot be sent, the record and the
   * token are removed again and the request stays open.
   */
  async approve(id: string): Promise<DeviceRecord> {
    const p = this.waiting(id)
    const hello = p.hello!
    if (!this.deps.online()) throw new Error('This Mac is not connected to the relay, so the phone cannot be told. Approve again once it shows "Connected".')
    p.stage = 'approving'
    p.error = undefined
    this.changed()
    const deviceId = randomUUID()
    let record: DeviceRecord | null = null
    try {
      const keys = await this.deps.devices.keyPair()
      if (!keys || toHex(keys.publicKey) !== p.desktopKey) throw new Error("This Mac's identity changed since the code was shown. Show a new code.")
      const relayToken = toHex(randomBytes(32))
      const tokenHash = sha256Hex(relayToken)
      const sid = randomUUID()
      await this.deps.registerDevice(deviceId, tokenHash)
      record = { id: deviceId, name: hello.deviceName.slice(0, 200), publicKey: hello.devicePub, tokenHash, sid, pairedAt: new Date(this.now()).toISOString(), lastSeq: 0, categories: [], needsRepair: false }
      await this.deps.devices.add(record)
      const ok = await this.reply(p, {
        pair: 'ok',
        ok: { deviceId, relayToken, desktopName: this.deps.desktopName.slice(0, LIMITS.idChars) || 'Mac', protocol: { ...PROTOCOL }, sid }
      })
      if (!ok) throw new Error('The connection to the relay dropped before the phone was told. Approve again once it shows "Connected".')
      p.stage = 'paired'
      this.changed()
      return record
    } catch (err) {
      if (record) {
        await this.deps.devices.remove(deviceId).catch(() => undefined)
        await this.deps.unregisterDevice(deviceId).catch(() => undefined)
      }
      if (this.pairings.get(id) === p) {
        p.stage = 'scanned'
        p.error = (err as Error).message
      }
      this.changed()
      throw err
    }
  }

  /** Deny: the phone is told, nothing is registered or kept; the secret stays consumed. */
  async deny(id: string): Promise<void> {
    const p = this.pairings.get(id)
    if (!p) return
    if (p.stage === 'waiting' || p.stage === 'expired') {
      this.drop(id)
      this.changed()
      return
    }
    const waiting = this.waiting(id)
    waiting.stage = 'denied'
    await this.reply(waiting, { pair: 'denied', reason: 'denied' })
    this.changed()
  }
}
