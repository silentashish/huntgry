/**
 * What the remote client needs from the host, injected so the same code runs on the phone
 * (expo-secure-store, the React Native WebSocket, real timers) and in Node tests (memory,
 * a fake socket, a fake clock). Nothing in `src/remote/` imports React Native.
 */

/** expo-secure-store's async API, reduced to what the client uses. */
export interface SecureStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  deleteItem(key: string): Promise<void>
}

/** The subset of the WHATWG WebSocket the client touches (React Native implements it). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: { code: number; reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export const SOCKET_OPEN = 1

export type SocketFactory = (url: string) => SocketLike

export interface Clock {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/** In-memory storage (tests, the demo mode and web, where there is no secure store). */
export class MemoryStorage implements SecureStorage {
  readonly data = new Map<string, string>()
  async getItem(key: string): Promise<string | null> {
    return this.data.get(key) ?? null
  }
  async setItem(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }
  async deleteItem(key: string): Promise<void> {
    this.data.delete(key)
  }
}
