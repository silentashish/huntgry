import { describe, expect, it } from 'vitest'
import { BOARD_ORIGIN_ENV, boardOrigin } from './board-url'
import { hiringCafeSearchUrl, HIRINGCAFE_ORIGIN } from './sources/hiringcafe'
import { INDEED_ORIGIN, indeedSearchUrl, parseIndeedCards } from './sources/indeed'

const q = { keywords: 'platform engineer', location: '', remoteOnly: false }

describe('boardOrigin', () => {
  it('is the real board without the variable', () => {
    expect(boardOrigin('hiring.cafe', {}, false)).toBe(HIRINGCAFE_ORIGIN)
    expect(boardOrigin('indeed', {}, false)).toBe(INDEED_ORIGIN)
    expect(boardOrigin('indeed', { [BOARD_ORIGIN_ENV.indeed]: '   ' }, false)).toBe(INDEED_ORIGIN)
  })

  it('accepts a loopback origin in an unpackaged build (path and trailing slash dropped)', () => {
    const env = {
      [BOARD_ORIGIN_ENV['hiring.cafe']]: 'http://127.0.0.1:43123/',
      [BOARD_ORIGIN_ENV.indeed]: 'http://localhost:43123/jobs'
    }
    expect(boardOrigin('hiring.cafe', env, false)).toBe('http://127.0.0.1:43123')
    expect(boardOrigin('indeed', env, false)).toBe('http://localhost:43123')
  })

  it('is ignored by packaged builds whatever the environment says', () => {
    const env = { [BOARD_ORIGIN_ENV['hiring.cafe']]: 'http://127.0.0.1:43123/' }
    expect(boardOrigin('hiring.cafe', env, true)).toBe(HIRINGCAFE_ORIGIN)
    // The module counts as packaged until main reports otherwise.
    expect(boardOrigin('hiring.cafe', env)).toBe(HIRINGCAFE_ORIGIN)
  })

  it('refuses anything that is not a loopback http(s) URL', () => {
    for (const value of [
      'https://evil.example/',
      'http://10.0.0.5:8080/',
      'http://192.168.1.10/',
      'http://169.254.169.254/',
      'file:///tmp/board.html',
      'not a url'
    ]) {
      expect(boardOrigin('hiring.cafe', { [BOARD_ORIGIN_ENV['hiring.cafe']]: value }, false)).toBe(HIRINGCAFE_ORIGIN)
    }
  })

  it('is what the search URL builders and the Indeed job links use', () => {
    expect(hiringCafeSearchUrl(q, 'http://127.0.0.1:43123')).toMatch(/^http:\/\/127\.0\.0\.1:43123\/\?searchState=/)
    expect(hiringCafeSearchUrl(q)).toMatch(/^https:\/\/hiringcafe\.com\//)
    expect(indeedSearchUrl(q, 'http://127.0.0.1:43123')).toMatch(/^http:\/\/127\.0\.0\.1:43123\/jobs\?q=/)
    expect(indeedSearchUrl(q)).toMatch(/^https:\/\/www\.indeed\.com\/jobs\?/)
    const [job] = parseIndeedCards({ results: [{ jobkey: 'abcdef0123456789', title: 'T' }] }, new Date(), 'http://127.0.0.1:43123')
    expect(job.url).toBe('http://127.0.0.1:43123/viewjob?jk=abcdef0123456789')
  })
})
