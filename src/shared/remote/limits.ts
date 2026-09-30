import { utf8Encode } from './text'

/**
 * Byte limits, all enforced by the producer before encryption and by the relay on receipt.
 * Base64 inflates by 4/3, the box tag adds 16 bytes, RelayFrame + Envelope JSON add ≈ 600 bytes,
 * so 40 KiB of plaintext is ≈ 54 KiB of `ct` and the frame stays under 64 KiB.
 */
export const LIMITS = {
  /** UTF-8 length of the serialised RelayFrame; the relay drops larger frames with `tooLarge`. */
  frameBytes: 64 * 1024,
  /** UTF-8 length of the serialised Envelope before boxing. */
  plaintextBytes: 40 * 1024,
  /** run.reply.text, review.rerun.answers, enqueue notes: UTF-8 bytes, below the desktop's MAX_TEXT. */
  textBytes: 32 * 1024,
  /** Binary bytes per file.chunk (32 KiB once base64-encoded). */
  fileChunkBytes: 24 * 1024,
  /** text / output of one RemoteTranscriptItem, then `truncated: true`. */
  transcriptItemTextBytes: 8 * 1024,
  /** run.get returns at most this many items per page. */
  transcriptPageItems: 20,
  jobsPageItems: 50,
  /** Longer review-notes.md are fetched through file.get instead of inline. */
  reviewNotesInlineBytes: 16 * 1024,
  /** `RemoteRun.error` / `RemoteQueueItem.error`, truncated by the projector. */
  errorBytes: 1024,
  /** `RelayFrame.pushText` (characters; it is shown as a notification body). */
  pushTextChars: 80,
  /** `queue.changed` / `queue.get` carry at most this many items (active first); `more` counts the rest. */
  queueItems: 20,
  /** Run, queue item, device and session ids, command ids, revisions. */
  idChars: 128,
  /** Job ids are `<source>:<source id>`: a 16-hex hash (url, pasted), Indeed's job key or hiring.cafe's id. */
  jobIdChars: 64,
  /** Application ids are folder paths (`<role>/<company>/<job-id>`), the desktop allows 600. */
  applicationIdChars: 600,
  /** `applications.changed` carries at most this many ids per event. */
  applicationsChangedIds: 50,
  /** Paging cursors. */
  cursorChars: 256,
  /** Titles, names and other labels in DTOs, truncated by the projector. */
  titleChars: 200,
  /** Everything else that is a short string (messages, URLs). */
  shortStringChars: 2048
} as const

/** `Envelope.ttl` / `RelayFrame.ttl` bounds in seconds. Settings may raise a TTL up to `max`. */
export const TTL_SECONDS = { min: 1, max: 7 * 24 * 60 * 60 } as const

/** Skew the receiver tolerates on `Envelope.ts` in the future (clock drift between phone and Mac). */
export const MAX_CLOCK_SKEW_SECONDS = 5 * 60

/** UTF-8 byte length of a string (what every byte limit above counts). */
export function utf8Bytes(text: string): number {
  return utf8Encode(text).byteLength
}

/** Bytes of the JSON serialisation of `value`. */
export function jsonBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value))
}

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a code point.
 * Returns `truncated: true` when something was removed.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (utf8Bytes(text) <= maxBytes) return { text, truncated: false }
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid
    else hi = mid - 1
  }
  // Never end on the high half of a surrogate pair.
  let end = lo
  const last = text.charCodeAt(end - 1)
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: text.slice(0, end), truncated: true }
}
