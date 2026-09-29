import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/**
 * Validates a path received over IPC. Expands a leading `~` so users can type
 * `~/cv`; anything else must already be absolute. Returns null when unusable.
 */
export function normalizeInputPath(input: unknown, home: string = homedir()): string | null {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (trimmed.length === 0 || trimmed.length > 4096 || trimmed.includes('\0')) return null
  const expanded =
    trimmed === '~' ? home : /^~[/\\]/.test(trimmed) ? join(home, trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? resolve(expanded) : null
}
