import { describe, expect, it } from 'vitest'
import { requireBoolean, requireCommandTtlInput, requireConfigureInput, requireRemoteId } from './validate'

/** What the renderer may send to the remote API (#37): ids, booleans, whole numbers, the relay URL and admin token. */

describe('remote IPC validators', () => {
  it('booleans only', () => {
    expect(requireBoolean(true)).toBe(true)
    for (const v of ['true', 1, null, undefined, {}]) expect(() => requireBoolean(v)).toThrow(/Invalid/)
  })

  it('ids: UUID-like strings only (no paths, no objects, no keys)', () => {
    expect(requireRemoteId('3f1c2a9e-7b1d-4c55-9a61-0e2f5b8d7c10')).toBe('3f1c2a9e-7b1d-4c55-9a61-0e2f5b8d7c10')
    expect(requireRemoteId('dev-1234abcd')).toBe('dev-1234abcd')
    for (const v of ['', '../devices.json', '/Users/me/x', 'a b', 'x'.repeat(129), 'k+/=', 42, { id: 'x' }, ['x']]) {
      expect(() => requireRemoteId(v, 'device')).toThrow(/Invalid device/)
    }
  })

  it('relay form: https only with the reason shown, a one-line admin token, no other fields', () => {
    expect(requireConfigureInput({ relayUrl: ' https://relay.example.com/ ', adminToken: ' tok ' })).toEqual({ relayUrl: 'https://relay.example.com', adminToken: 'tok' })
    expect(() => requireConfigureInput({ relayUrl: 'http://relay.example.com', adminToken: 'tok' })).toThrow(/must start with https:\/\//)
    expect(() => requireConfigureInput({ relayUrl: 'wss://relay.example.com', adminToken: 'tok' })).toThrow(/https:\/\//)
    expect(() => requireConfigureInput({ relayUrl: 'https://user:pw@relay.example.com', adminToken: 'tok' })).toThrow(/credentials/)
    expect(() => requireConfigureInput({ relayUrl: 'https://relay.example.com?x=1', adminToken: 'tok' })).toThrow(/query/)
    expect(() => requireConfigureInput({ relayUrl: 'https://relay.example.com', adminToken: '  ' })).toThrow(/admin token/)
    expect(() => requireConfigureInput({ relayUrl: 'https://relay.example.com', adminToken: 'a\nb' })).toThrow(/one line/)
    expect(() => requireConfigureInput({ relayUrl: 'https://relay.example.com', adminToken: 'tok', ownerSecret: 'x' })).toThrow(/Invalid/)
    expect(() => requireConfigureInput('https://relay.example.com')).toThrow(/Invalid/)
  })

  it('TTL fields: whole seconds between 1 minute and 7 days, both required', () => {
    expect(requireCommandTtlInput({ costlySeconds: 7200, defaultSeconds: 86400 })).toEqual({ costly: 7200, default: 86400 })
    expect(() => requireCommandTtlInput({ costlySeconds: 59, defaultSeconds: 86400 })).toThrow(/costly/)
    expect(() => requireCommandTtlInput({ costlySeconds: 7200, defaultSeconds: 8 * 86400 })).toThrow(/default/)
    expect(() => requireCommandTtlInput({ costlySeconds: 1.5 * 60, defaultSeconds: 86400 })).not.toThrow()
    expect(() => requireCommandTtlInput({ costlySeconds: 90.5, defaultSeconds: 86400 })).toThrow()
    expect(() => requireCommandTtlInput({ costlySeconds: '7200', defaultSeconds: 86400 })).toThrow()
    expect(() => requireCommandTtlInput({ costlySeconds: 7200 })).toThrow()
    expect(() => requireCommandTtlInput({ costlySeconds: 7200, defaultSeconds: 86400, path: '/tmp' })).toThrow(/Invalid/)
  })
})
