import { describe, expect, it } from 'vitest'
import { COMMAND_TTL_SECONDS, PROTOCOL } from './protocol'
import { jsonBytes, LIMITS, MAX_CLOCK_SKEW_SECONDS, truncateUtf8, TTL_SECONDS, utf8Bytes } from './limits'

describe('LIMITS and TTLs match ADR-0001', () => {
  it('byte limits', () => {
    expect(LIMITS).toMatchObject({
      frameBytes: 65536,
      plaintextBytes: 40960,
      textBytes: 32768,
      fileChunkBytes: 24576,
      transcriptItemTextBytes: 8192,
      transcriptPageItems: 20,
      jobsPageItems: 50,
      reviewNotesInlineBytes: 16384
    })
    expect(LIMITS.pushTextChars).toBe(80)
    expect(LIMITS.errorBytes).toBe(1024)
  })

  it('command TTLs: 2 h costly, 24 h default, within the bounds', () => {
    expect(COMMAND_TTL_SECONDS).toEqual({ costly: 7200, default: 86400 })
    expect(TTL_SECONDS.min).toBe(1)
    expect(TTL_SECONDS.max).toBeGreaterThanOrEqual(COMMAND_TTL_SECONDS.default)
    expect(MAX_CLOCK_SKEW_SECONDS).toBe(300)
    expect(PROTOCOL).toEqual({ min: 1, max: 1 })
  })

  it('a 24 KiB chunk is 32 KiB once base64-encoded, and the plaintext budget leaves room for the frame', () => {
    expect(Math.ceil(LIMITS.fileChunkBytes / 3) * 4).toBe(32 * 1024)
    // base64(plaintext + tag) + ≈ 600 bytes of JSON must fit in frameBytes.
    expect(Math.ceil((LIMITS.plaintextBytes + 16) / 3) * 4 + 600).toBeLessThan(LIMITS.frameBytes)
  })
})

describe('utf8 helpers', () => {
  it('counts bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('é')).toBe(2)
    expect(utf8Bytes('😀')).toBe(4)
    expect(jsonBytes({ a: 'é' })).toBe(utf8Bytes('{"a":"é"}'))
  })

  it('truncates on a code point boundary', () => {
    expect(truncateUtf8('abc', 3)).toEqual({ text: 'abc', truncated: false })
    expect(truncateUtf8('abcd', 3)).toEqual({ text: 'abc', truncated: true })
    expect(truncateUtf8('aé', 2)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('a😀', 4)).toEqual({ text: 'a', truncated: true })
    expect(truncateUtf8('a😀', 5)).toEqual({ text: 'a😀', truncated: false })
    expect(utf8Bytes(truncateUtf8('😀'.repeat(100), 33).text)).toBe(32)
  })
})

describe('base64 length check', () => {
  it('counts decoded bytes, so padding cannot hide a short value', async () => {
    const { base64DecodedBytes, requireBase64 } = await import('./check')
    for (const n of [0, 1, 2, 3, 22, 23, 24, 25]) expect(base64DecodedBytes(Buffer.alloc(n).toString('base64'))).toBe(n)
    expect(() => requireBase64(Buffer.alloc(24).toString('base64'), 'nonce', 24)).not.toThrow()
    expect(() => requireBase64(Buffer.alloc(23).toString('base64'), 'nonce', 24)).toThrow(/24 bytes/)
    expect(() => requireBase64(Buffer.alloc(22).toString('base64'), 'nonce', 24)).toThrow(/24 bytes/)
  })
})
