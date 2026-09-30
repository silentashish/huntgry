import { describe, expect, it } from 'vitest'
import { createPublicHostCheck, createRequestGuard, HOST_CHECK_TTL_MS } from './public-host'

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

describe('createRequestGuard', () => {
  const check = createPublicHostCheck(async () => ['93.184.216.34'])
  const decide = (guard: ReturnType<typeof createRequestGuard>, url: string) =>
    new Promise<boolean>((resolve) => guard({ url }, (r) => resolve(r.cancel)))

  it('cancels loopback and private addresses, lets public hosts through', async () => {
    const guard = createRequestGuard(false, check)
    expect(await decide(guard, 'https://jobs.example.com/1')).toBe(false)
    expect(await decide(guard, 'http://127.0.0.1:4173/lever/')).toBe(true)
    expect(await decide(guard, 'http://localhost:4173/')).toBe(true)
    expect(await decide(guard, 'http://10.0.0.5/')).toBe(true)
  })

  it('with the loopback allowance lets only loopback through; the private network stays refused', async () => {
    const guard = createRequestGuard(true, check)
    expect(await decide(guard, 'http://127.0.0.1:4173/lever/')).toBe(false)
    expect(await decide(guard, 'ws://localhost:4173/socket')).toBe(false)
    expect(await decide(guard, 'http://[::1]:4173/')).toBe(false)
    expect(await decide(guard, 'http://10.0.0.5/')).toBe(true)
    expect(await decide(guard, 'http://192.168.1.10/')).toBe(true)
    expect(await decide(guard, 'http://169.254.169.254/latest')).toBe(true)
    expect(await decide(guard, 'https://jobs.example.com/1')).toBe(false)
  })
})
