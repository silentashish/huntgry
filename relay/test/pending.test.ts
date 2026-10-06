import { describe, expect, it } from 'vitest'
import { LIMITS } from '@huntgry/remote-protocol'
import { PENDING_BYTES_MAX, PENDING_FRAMES_MAX, PendingFrames } from '../src/pending'

/** The pre-room buffer of GET /ws: bounded by count and by bytes, nothing kept on refusal. */
describe('PendingFrames', () => {
  it('holds frames in order and drains them once', () => {
    const p = new PendingFrames()
    expect(p.add('a')).toBeNull()
    expect(p.add('b')).toBeNull()
    expect(p.drain()).toEqual(['a', 'b'])
    expect(p.drain()).toEqual([])
  })

  it('refuses one frame over LIMITS.frameBytes, counted in UTF-8 bytes', () => {
    expect(new PendingFrames().add('x'.repeat(LIMITS.frameBytes + 1))).toBe('tooBig')
    expect(new PendingFrames().add('é'.repeat(LIMITS.frameBytes / 2 + 1))).toBe('tooBig')
    expect(new PendingFrames().add('x'.repeat(LIMITS.frameBytes))).toBeNull()
  })

  it('refuses frames whose total would pass two full frames', () => {
    const p = new PendingFrames()
    const chunk = 'x'.repeat(40_000)
    const fits = Math.floor(PENDING_BYTES_MAX / chunk.length)
    for (let i = 0; i < fits; i++) expect(p.add(chunk)).toBeNull()
    expect(p.add(chunk)).toBe('tooBig')
    expect(p.drain()).toHaveLength(fits)
  })

  it('refuses more than the frame count and binary frames', () => {
    const p = new PendingFrames()
    for (let i = 0; i < PENDING_FRAMES_MAX; i++) expect(p.add('{}')).toBeNull()
    expect(p.add('{}')).toBe('tooMany')
    expect(new PendingFrames().add(new ArrayBuffer(4))).toBe('tooMany')
  })
})
