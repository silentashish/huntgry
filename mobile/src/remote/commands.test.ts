import { LIMITS, ProtocolError, requireEnvelope } from '@huntgry/remote-protocol'
import { describe, expect, it } from 'vitest'
import { commandLabel, commands, deliveryFromNotice, DELIVERY_COPY, envelopeFor, needsWorkspace, NoWorkspaceError } from './commands'

const base = { id: '0e2f6a55-0c4b-4b5e-9a62-1f7d2c3b4a59', sid: 'sid-1', seq: 7, now: Date.parse('2026-10-09T12:00:00.000Z'), workspaceId: 'a'.repeat(32) }

describe('command builders', () => {
  it('go through requireCommand: bad arguments throw before anything is sent', () => {
    expect(() => commands.reply('run-1', '   ')).toThrow(ProtocolError)
    expect(() => commands.reply('run-1', 'x'.repeat(LIMITS.textBytes + 1))).toThrow(/32768|bytes/)
    expect(() => commands.reply('run-1', 'x'.repeat(LIMITS.textBytes))).not.toThrow()
    expect(() => commands.cancel('')).toThrow(ProtocolError)
    expect(() => commands.run('run-1', -1)).toThrow(ProtocolError)
    expect(commands.run('run-1', 20)).toEqual({ name: 'run.get', args: { runId: 'run-1', sinceSeq: 20 } })
    expect(commands.status()).toEqual({ name: 'status.get' })
  })

  it('send notification categories in the package order without repeats', () => {
    expect(commands.setNotifications(['failed', 'needs-reply', 'failed'])).toEqual({ name: 'device.setNotifications', args: { categories: ['needs-reply', 'failed'] } })
  })

  it('build envelopes that pass the desktop guard, with ttl by cost and ws where needed', () => {
    const reply = envelopeFor({ ...base, command: commands.reply('run-1', 'ok') })
    expect(reply).toEqual({ v: 1, sid: 'sid-1', from: 'phone', seq: 7, ts: '2026-10-09T12:00:00.000Z', ttl: 7200, kind: 'cmd', id: base.id, name: 'run.reply', ws: base.workspaceId, body: { runId: 'run-1', text: 'ok' } })
    expect(requireEnvelope(reply)).toEqual(reply)
    const pause = envelopeFor({ ...base, command: commands.setQueuePaused(true) })
    expect(pause.ttl).toBe(86_400)
    const status = envelopeFor({ ...base, workspaceId: null, command: commands.status() })
    expect(status.ws).toBeUndefined()
    expect(status.body).toBeNull()
    expect(() => envelopeFor({ ...base, workspaceId: null, command: commands.queue() })).toThrow(NoWorkspaceError)
    expect(needsWorkspace('device.setNotifications')).toBe(false)
    expect(needsWorkspace('run.get')).toBe(true)
  })

  it('honour TTLs changed in desktop Settings', () => {
    expect(envelopeFor({ ...base, ttls: { costly: 600, default: 3600 }, command: commands.reply('r', 'x') }).ttl).toBe(600)
  })
})

describe('delivery states', () => {
  it('map relay notices to the copy the owner sees', () => {
    expect(deliveryFromNotice({ queued: true, ref: 'a' })).toEqual({ ref: 'a', state: 'queued' })
    expect(deliveryFromNotice({ expired: true, ref: 'b' })).toEqual({ ref: 'b', state: 'expired' })
    expect(deliveryFromNotice({ presence: 'online', since: '2026-10-09T12:00:00.000Z', queued: 0 })).toBeNull()
    expect(DELIVERY_COPY.queued).toBe('Will run when your Mac wakes')
    expect(DELIVERY_COPY.expired).toBe('Expired before your Mac woke up')
  })

  it('label commands for the "Queued on the relay" list', () => {
    expect(commandLabel(commands.pipelinePause())).toBe('Pause pipeline')
    expect(commandLabel(commands.reply('run-1', 'x'), () => 'Stripe run')).toBe('Reply · Stripe run')
    expect(commandLabel(commands.setQueuePaused(false))).toBe('Resume queue')
  })
})
