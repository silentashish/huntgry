import { LIMITS, requireFileChunk } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { FILE_COPY, FileDownload, FileError, chunksOf, fileLabel, fileSize, mimeOf, pageNumber, sha256Hex } from './files'

const APP = 'platform-engineer/initech/init-9'

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 31 + seed) & 0xff
  return out
}

function download(data: Uint8Array, expected?: string) {
  const dl = new FileDownload(APP, 'resume.pdf', expected)
  const chunks = chunksOf(APP, 'resume.pdf', data)
  return { dl, chunks }
}

describe('file reassembly', () => {
  it('reassembles a 60 000-byte PDF from 24 KiB chunks and checks the whole-file SHA-256', () => {
    const data = bytes(60_000)
    const { dl, chunks } = download(data)
    expect(chunks.map((c) => [c.chunk, c.of])).toEqual([
      [0, 3],
      [1, 3],
      [2, 3]
    ])
    // The chunks pass the package's own guard, like the desktop's.
    for (const c of chunks) requireFileChunk(c)
    expect(dl.add(chunks[0])).toEqual({ done: false, next: 1 })
    expect(dl.progress).toEqual({ received: 1, of: 3, bytes: 60_000 })
    expect(dl.add(chunks[1])).toEqual({ done: false, next: 2 })
    const last = dl.add(chunks[2])
    expect(last.done).toBe(true)
    if (last.done) expect(last.data).toEqual(data)
    expect(dl.sha256).toBe(sha256Hex(data))
  })

  it('handles an empty file and an exact multiple of the chunk size', () => {
    const empty = download(new Uint8Array(0))
    expect(empty.chunks).toHaveLength(1)
    expect(empty.dl.add(empty.chunks[0])).toEqual({ done: true, data: new Uint8Array(0) })
    const exact = download(bytes(LIMITS.fileChunkBytes * 2))
    expect(exact.chunks).toHaveLength(2)
    exact.dl.add(exact.chunks[0])
    expect(exact.dl.add(exact.chunks[1]).done).toBe(true)
  })

  it('rejects a reassembled file whose hash differs (a flipped byte)', () => {
    const data = bytes(30_000)
    const { dl, chunks } = download(data)
    const tampered = new Uint8Array(30_000 - LIMITS.fileChunkBytes)
    tampered.set(data.subarray(LIMITS.fileChunkBytes))
    tampered[10] ^= 1
    const bad = chunksOf(APP, 'resume.pdf', tampered)[0]
    dl.add(chunks[0])
    // Same claimed hash, different bytes.
    expect(() => dl.add({ ...chunks[1], data: bad.data })).toThrow(FILE_COPY.mismatch)
  })

  it('refuses a file that is not the one the review revision listed', () => {
    const { dl, chunks } = download(bytes(1000), 'f'.repeat(64))
    expect(() => dl.add(chunks[0])).toThrow(FileError)
    expect(() => new FileDownload(APP, 'resume.pdf', 'f'.repeat(64)).add(chunks[0])).toThrow(FILE_COPY.revision)
    const ok = download(bytes(1000), sha256Hex(bytes(1000)))
    expect(ok.dl.add(ok.chunks[0]).done).toBe(true)
  })

  it('stops when the file changes on the Mac mid-download (a regenerated PDF)', () => {
    const { dl, chunks } = download(bytes(60_000))
    const regenerated = chunksOf(APP, 'resume.pdf', bytes(60_000, 9))
    dl.add(chunks[0])
    expect(() => dl.add(regenerated[1])).toThrow(FILE_COPY.changed)
  })

  it('refuses chunks out of order, of another file or application, or of the wrong size', () => {
    const { dl, chunks } = download(bytes(60_000))
    expect(() => dl.add(chunks[1])).toThrow(FILE_COPY.malformed)
    expect(() => dl.add({ ...chunks[0], file: 'cover.pdf' })).toThrow(FILE_COPY.malformed)
    expect(() => dl.add({ ...chunks[0], applicationId: 'other/app/x' })).toThrow(FILE_COPY.malformed)
    expect(() => dl.add({ ...chunks[0], of: 2 })).toThrow(FILE_COPY.malformed)
    const short = chunksOf(APP, 'resume.pdf', bytes(100))[0]
    expect(() => new FileDownload(APP, 'resume.pdf').add({ ...chunks[0], data: short.data })).toThrow(FILE_COPY.malformed)
  })
})

describe('file labels', () => {
  it('name, size, type and page', () => {
    expect(fileLabel('resume.pdf')).toBe('Resume (PDF)')
    expect(fileLabel('cover-page-2.jpg')).toBe('Cover letter · page 2')
    expect(fileLabel('review-notes.md')).toBe('Review notes')
    expect(fileSize(60_000)).toBe('59 KB')
    expect(fileSize(2_500_000)).toBe('2.4 MB')
    expect(mimeOf('resume.pdf')).toBe('application/pdf')
    expect(mimeOf('resume-page-1.jpg')).toBe('image/jpeg')
    expect(pageNumber('resume-page-12.jpg')).toBe(12)
    expect(pageNumber('resume.pdf')).toBeNull()
  })
})
