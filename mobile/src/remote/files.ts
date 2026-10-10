/**
 * Application files from the Mac (#40): `file.get` answers one `FileChunk` of at most
 * `LIMITS.fileChunkBytes` per command, each with the whole file's size and SHA-256. A
 * `FileDownload` asks for the chunks in order, checks that every chunk describes the same file,
 * reassembles them and accepts the result only when its own SHA-256 matches the one the Mac
 * sent (and, for a review preview, the one the `ReviewDetail` listed for that revision).
 * Anything else is refused and the bytes are dropped. Plain TypeScript, tested in Node.
 */

import { sha256 } from '@noble/hashes/sha2.js'
import { LIMITS, fromBase64, toBase64, toHex, type FileChunk, type RemoteFile } from '@huntgry/remote-protocol'

/** The one key for a file of an application in the model's maps. */
export function fileKey(applicationId: string, file: RemoteFile): string {
  return `${applicationId}\u0000${file}`
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes))
}

export class FileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileError'
  }
}

export const FILE_COPY = {
  mismatch: 'The file did not match its checksum and was discarded. Try again.',
  changed: 'The file changed on your Mac while it was loading.',
  revision: 'This file is not the one the review was built from. Reload the result.',
  malformed: 'Your Mac sent a piece of this file that does not fit.'
} as const

export type ChunkOutcome = { done: false; next: number } | { done: true; data: Uint8Array }

export class FileDownload {
  private parts: Uint8Array[] = []
  private of = 0
  private bytes = 0
  private hash: string | null = null

  /**
   * `expected`: the SHA-256 a `ReviewDetail` listed for this file. A file whose hash differs is
   * not the one that revision was built from, even if it arrived intact.
   */
  constructor(
    readonly applicationId: string,
    readonly file: RemoteFile,
    readonly expected?: string
  ) {}

  /** The chunk to ask for next. */
  get next(): number {
    return this.parts.length
  }

  get progress(): { received: number; of: number; bytes: number } {
    return { received: this.parts.length, of: this.of, bytes: this.bytes }
  }

  /** The Mac's SHA-256 of the whole file (from the first chunk). */
  get sha256(): string | null {
    return this.hash
  }

  /** Adds the answer to `file.get` for chunk `next`; throws `FileError` for anything that does not belong. */
  add(chunk: FileChunk): ChunkOutcome {
    if (chunk.applicationId !== this.applicationId || chunk.file !== this.file || chunk.chunk !== this.parts.length) throw new FileError(FILE_COPY.malformed)
    if (this.hash === null) {
      this.of = chunk.of
      this.bytes = chunk.bytes
      this.hash = chunk.sha256
      if (this.expected !== undefined && this.hash !== this.expected) throw new FileError(FILE_COPY.revision)
      // Chunks are full except the last: the count follows from the size.
      if (this.of !== Math.max(1, Math.ceil(this.bytes / LIMITS.fileChunkBytes))) throw new FileError(FILE_COPY.malformed)
    } else if (chunk.sha256 !== this.hash || chunk.bytes !== this.bytes || chunk.of !== this.of) {
      throw new FileError(FILE_COPY.changed)
    }
    const data = fromBase64(chunk.data)
    const last = chunk.chunk === this.of - 1
    const want = last ? this.bytes - LIMITS.fileChunkBytes * (this.of - 1) : LIMITS.fileChunkBytes
    if (data.length !== want) throw new FileError(FILE_COPY.malformed)
    this.parts.push(data)
    if (!last) return { done: false, next: this.parts.length }
    return { done: true, data: this.assemble() }
  }

  private assemble(): Uint8Array {
    const out = new Uint8Array(this.bytes)
    let at = 0
    for (const p of this.parts) {
      out.set(p, at)
      at += p.length
    }
    this.parts = []
    // The phone's own check: the bytes it holds are the bytes the Mac hashed.
    if (at !== this.bytes || sha256Hex(out) !== this.hash) throw new FileError(FILE_COPY.mismatch)
    return out
  }
}

/** Splits a file into the chunks the gateway would send (tests and the demo Mac). */
export function chunksOf(applicationId: string, file: RemoteFile, data: Uint8Array): FileChunk[] {
  const size = LIMITS.fileChunkBytes
  const of = Math.max(1, Math.ceil(data.length / size))
  const hash = sha256Hex(data)
  const out: FileChunk[] = []
  for (let i = 0; i < of; i++) {
    const piece = data.subarray(i * size, Math.min(data.length, (i + 1) * size))
    out.push({ applicationId, file, chunk: i, of, bytes: data.length, sha256: hash, data: toBase64(piece) })
  }
  return out
}

/** The MIME type the OS viewer opens a file with. */
export function mimeOf(file: RemoteFile): string {
  if (file.endsWith('.pdf')) return 'application/pdf'
  if (file.endsWith('.jpg')) return 'image/jpeg'
  return 'text/markdown'
}

/** Page previews in page order: `resume-page-1.jpg`, `resume-page-2.jpg`, … */
export function pageNumber(file: RemoteFile): number | null {
  const m = /-page-(\d+)\.jpg$/.exec(file)
  return m ? Number(m[1]) : null
}

export function isPage(file: RemoteFile): boolean {
  return pageNumber(file) !== null
}

/** "resume.pdf" → "Resume (PDF)", "cover-page-2.jpg" → "Cover letter · page 2", "review-notes.md" → "Review notes". */
export function fileLabel(file: RemoteFile): string {
  const doc = file.startsWith('cover') ? 'Cover letter' : file.startsWith('resume') ? 'Resume' : 'Review notes'
  const page = pageNumber(file)
  if (page !== null) return `${doc} · page ${page}`
  if (file.endsWith('.pdf')) return `${doc} (PDF)`
  return doc
}

/** "61 KB", "1.2 MB", "900 B" */
export function fileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

/** UTF-8 bytes → text (review-notes.md; demo SVG pages). Invalid sequences become U+FFFD. */
export function utf8Text(bytes: Uint8Array): string {
  const TD = (globalThis as { TextDecoder?: new () => { decode(b: Uint8Array): string } }).TextDecoder
  if (TD) return new TD().decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    const n = b < 0x80 ? 0 : b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1
    if (n < 0 || i + n >= bytes.length + (n === 0 ? 1 : 0)) {
      out += '�'
      i++
      continue
    }
    let cp = n === 0 ? b : b & (0x3f >> n)
    for (let k = 1; k <= n; k++) cp = (cp << 6) | (bytes[i + k] & 0x3f)
    out += String.fromCodePoint(cp)
    i += n + 1
  }
  return out
}
