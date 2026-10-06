/**
 * The frames `GET /ws` holds while it is still connecting to the room named in the auth frame.
 * Nothing is authenticated yet, so the bound is on bytes as well as on count: one frame at most
 * `LIMITS.frameBytes`, all of them together at most two such frames.
 */
import { LIMITS, utf8Bytes } from '@huntgry/remote-protocol'

export const PENDING_FRAMES_MAX = 16
export const PENDING_BYTES_MAX = 2 * LIMITS.frameBytes

export type PendingRefusal = 'tooMany' | 'tooBig'

export class PendingFrames {
  private readonly frames: string[] = []
  private bytes = 0

  /** Holds `data`, or says why the socket must close instead (nothing is kept then). */
  add(data: string | ArrayBuffer): PendingRefusal | null {
    if (this.frames.length >= PENDING_FRAMES_MAX || typeof data !== 'string') return 'tooMany'
    const bytes = utf8Bytes(data)
    if (bytes > LIMITS.frameBytes || this.bytes + bytes > PENDING_BYTES_MAX) return 'tooBig'
    this.bytes += bytes
    this.frames.push(data)
    return null
  }

  /** Everything held, in arrival order, and empties the buffer. */
  drain(): string[] {
    this.bytes = 0
    return this.frames.splice(0)
  }
}
