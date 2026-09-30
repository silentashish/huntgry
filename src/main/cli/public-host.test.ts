import { describe, expect, it } from 'vitest'
import { createPublicHostCheck, HOST_CHECK_TTL_MS } from './public-host'

describe('createPublicHostCheck', () => {
  it('allows public hosts and refuses loopback, private and unparsable URLs', async () => {
    const check = createPublicHostCheck(async (host) => (host === 'intranet.example' ? ['10.0.0.5'] : ['93.184.216.34']))
    expect(await check('https://jobs.example.com/1')).toBe(true)
    expect(await check('wss://jobs.example.com/socket')).toBe(true)
    expect(await check('http://127.0.0.1:8080/')).toBe(false)
    expect(await check('http://localhost/')).toBe(false)
    expect(await check('http://169.254.169.254/latest')).toBe(false)
    expect(await check('https://intranet.example/')).toBe(false)
    expect(await check('not a url')).toBe(false)
  })

  it('caches the answer per host for the TTL', async () => {
    let t = 0
    let lookups = 0
    const check = createPublicHostCheck(
      async () => {
        lookups++
        return ['93.184.216.34']
      },
      () => t
    )
    await check('https://a.example/1')
    await check('https://a.example/2')
    expect(lookups).toBe(1)
    t = HOST_CHECK_TTL_MS + 1
    await check('https://a.example/3')
    expect(lookups).toBe(2)
  })
})
