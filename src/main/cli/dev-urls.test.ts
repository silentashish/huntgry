import { describe, expect, it } from 'vitest'
import { isLoopbackUrl, LOCAL_URLS_ENV, localUrlsAllowed, LOOPBACK_ONLY_ENV, loopbackOnly } from './dev-urls'

describe('dev-only URL escape hatches', () => {
  it('HUNTGRY_ALLOW_LOCAL_URLS=1 counts only in unpackaged builds', () => {
    expect(localUrlsAllowed(false, { [LOCAL_URLS_ENV]: '1' })).toBe(true)
    expect(localUrlsAllowed(true, { [LOCAL_URLS_ENV]: '1' })).toBe(false)
    expect(localUrlsAllowed(false, { [LOCAL_URLS_ENV]: 'true' })).toBe(false)
    expect(localUrlsAllowed(false, {})).toBe(false)
  })

  it('HUNTGRY_E2E_LOOPBACK_ONLY=1 counts only in unpackaged builds', () => {
    expect(loopbackOnly(false, { [LOOPBACK_ONLY_ENV]: '1' })).toBe(true)
    expect(loopbackOnly(true, { [LOOPBACK_ONLY_ENV]: '1' })).toBe(false)
    expect(loopbackOnly(false, { [LOOPBACK_ONLY_ENV]: '0' })).toBe(false)
    expect(loopbackOnly(false, {})).toBe(false)
  })

  it('isLoopbackUrl accepts loopback names and addresses on any port, nothing else', () => {
    for (const url of ['http://127.0.0.1:4173/', 'http://localhost/', 'https://[::1]:8443/x', 'ws://127.0.0.1/socket', 'http://127.1.2.3/']) {
      expect(isLoopbackUrl(url), url).toBe(true)
    }
    for (const url of ['http://10.0.0.1/', 'https://example.com/', 'file:///etc/hosts', 'http://intranet.local/', 'not a url']) {
      expect(isLoopbackUrl(url), url).toBe(false)
    }
  })
})
