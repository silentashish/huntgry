import { randomBytes, toHex } from '@huntgry/remote-protocol'

/** RFC 4122 version 4 uuid from `nacl.randomBytes` (react-native-get-random-values on Hermes). */
export function uuid(): string {
  const b = randomBytes(16)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = toHex(b)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** `https://host[/path]` → `wss://host[/path]/ws` (the relay URL was checked to be https when it was stored). */
export function socketUrl(relay: string, path: string): string {
  if (!relay.startsWith('https://')) throw new Error('The relay URL must use https://.')
  return `wss://${relay.slice('https://'.length)}${path}`
}
