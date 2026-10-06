import { describe, expect, it } from 'vitest'
import { backoffDelay, classifyFailure, LIMIT_MARGIN_MS, parseResetTime, STALL_PREFIX, unparsedLimitWait } from './failures'

// 2026-09-30 10:00 local time.
const NOW = new Date(2026, 8, 30, 10, 0, 0, 0).getTime()
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi, 0, 0).getTime()

describe('parseResetTime', () => {
  it('reads Claude "resets 3:45pm" today, or tomorrow when the time has passed', () => {
    expect(parseResetTime('claude', "You've hit your session limit · resets 3:45pm", NOW)).toEqual({ at: local(2026, 8, 30, 15, 45), parsed: true })
    expect(parseResetTime('claude', 'resets 9:30am', NOW)).toEqual({ at: local(2026, 9, 1, 9, 30), parsed: true })
    expect(parseResetTime('claude', 'resets 12:00am', NOW)).toEqual({ at: local(2026, 9, 1, 0, 0), parsed: true })
    expect(parseResetTime('claude', 'resets 12:15pm (America/Los_Angeles)', NOW)).toEqual({ at: local(2026, 8, 30, 12, 15), parsed: true })
  })

  it('reads Claude "resets Mon 12:00am" as the next Monday', () => {
    // 2026-09-30 is a Wednesday.
    expect(parseResetTime('claude', "You've hit your weekly limit · resets Mon 12:00am", NOW)).toEqual({ at: local(2026, 9, 5, 0, 0), parsed: true })
    expect(parseResetTime('claude', 'resets Wed 9:00am', NOW)).toEqual({ at: local(2026, 9, 7, 9, 0), parsed: true })
    expect(parseResetTime('claude', 'resets Wed 11:00am', NOW)).toEqual({ at: local(2026, 8, 30, 11, 0), parsed: true })
  })

  it('reads Codex "try again at Sep 24th, 2026 7:24 AM" as a local time, unparsed when in the past', () => {
    expect(parseResetTime('codex', 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage or try again at Oct 1st, 2026 7:24 AM.', NOW)).toEqual({ at: local(2026, 9, 1, 7, 24), parsed: true })
    expect(parseResetTime('codex', 'try again at Sep 24th, 2026 7:24 AM.', NOW)).toEqual({ parsed: false })
    expect(parseResetTime('codex', 'try again at Dec 2nd, 2026 12:05 PM', NOW)).toEqual({ parsed: false })
  })

  it('reads Antigravity "Resets in 34h23m28s" relative to now', () => {
    expect(parseResetTime('antigravity', 'Individual quota reached. Resets in 34h23m28s.', NOW)).toEqual({ at: NOW + (34 * 3600 + 23 * 60 + 28) * 1000, parsed: true })
    expect(parseResetTime('antigravity', 'Resets in 5m', NOW)).toEqual({ at: NOW + 5 * 60_000, parsed: true })
    expect(parseResetTime('antigravity', 'Individual quota reached.', NOW)).toEqual({ parsed: false })
  })

  it('gives up on garbage', () => {
    expect(parseResetTime('claude', 'nothing here', NOW)).toEqual({ parsed: false })
    expect(parseResetTime('claude', 'resets Xyz 3pm', NOW)).toEqual({ parsed: false })
  })
})

describe('classifyFailure', () => {
  it('classifies Claude failures', () => {
    expect(classifyFailure({ agent: 'claude', error: "You've hit your session limit · resets 3:45pm" }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: true, resetAt: local(2026, 8, 30, 15, 45) })
    expect(classifyFailure({ agent: 'claude', error: "You've hit your Opus limit · resets 3:45pm" }, NOW).kind).toBe('usage-limit')
    expect(classifyFailure({ agent: 'claude', error: "You've hit your weekly limit · resets Mon 12:00am\n\nclaude exited with code 1" }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: true })
    expect(classifyFailure({ agent: 'claude', error: "You've hit your monthly spend limit · raise it at claude.ai/settings" }, NOW).kind).toBe('spend-limit')
    expect(classifyFailure({ agent: 'claude', error: 'API Error: Server is temporarily limiting requests (not your usage limit)' }, NOW).kind).toBe('burst-limit')
    expect(classifyFailure({ agent: 'claude', error: 'API Error: Request rejected (429) · this may be a temporary capacity issue' }, NOW).kind).toBe('burst-limit')
    expect(classifyFailure({ agent: 'claude', error: 'Repeated 529 Overloaded errors' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'claude', error: 'boom\n\nclaude exited with code 3' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'claude', error: 'read ECONNRESET' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'claude', error: undefined }, NOW)).toMatchObject({ kind: 'transient', message: 'The run failed.' })
    expect(classifyFailure({ agent: 'claude', error: 'Claude Code is not signed in. Run claude auth login in a terminal.' }, NOW).kind).toBe('permanent')
    expect(classifyFailure({ agent: 'claude', error: "error: unknown option '--permission-prompts'" }, NOW).kind).toBe('permanent')
    expect(classifyFailure({ agent: 'claude', error: 'Claude ended the turn with error_max_turns' }, NOW).kind).toBe('permanent')
    expect(classifyFailure({ agent: 'claude', error: `${STALL_PREFIX} 20 minutes.` }, NOW).kind).toBe('stall')
  })

  it("prefers Claude's rate_limit_event epoch over the text, and treats a rejected event as a usage limit", () => {
    const epoch = Math.floor((NOW + 3600_000) / 1000)
    const f = classifyFailure({ agent: 'claude', error: "You've hit your session limit · resets 3:45pm", rateLimit: { status: 'rejected', resetsAt: epoch } }, NOW)
    expect(f).toMatchObject({ kind: 'usage-limit', parsed: true, resetAt: epoch * 1000 })
    expect(classifyFailure({ agent: 'claude', error: 'claude exited with code 1', rateLimit: { status: 'rejected' } }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: false })
    // A stale epoch (days ago) falls back to the text.
    expect(classifyFailure({ agent: 'claude', error: 'resets 3:45pm', rateLimit: { status: 'rejected', resetsAt: 1000 } }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: true, resetAt: local(2026, 8, 30, 15, 45) })
    expect(classifyFailure({ agent: 'claude', error: 'boom', rateLimit: { status: 'allowed_warning', utilization: 0.9 } }, NOW).kind).toBe('transient')
  })

  it('classifies Codex and Antigravity failures', () => {
    expect(classifyFailure({ agent: 'codex', error: 'You’ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 1st, 2026 7:24 AM.' }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: true, resetAt: local(2026, 9, 1, 7, 24) })
    expect(classifyFailure({ agent: 'codex', error: 'usage_limit_exceeded' }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: false })
    expect(classifyFailure({ agent: 'codex', error: 'You are out of credits.' }, NOW).kind).toBe('spend-limit')
    expect(classifyFailure({ agent: 'codex', error: 'rate_limit_exceeded' }, NOW).kind).toBe('burst-limit')
    expect(classifyFailure({ agent: 'codex', error: 'stream disconnected before completion' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'codex', error: 'server_overloaded' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'codex', error: 'Codex is not signed in. Run "codex login" in a terminal, then try again.' }, NOW).kind).toBe('permanent')
    expect(classifyFailure({ agent: 'antigravity', error: "Antigravity's quota is used up: RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 34h23m28s." }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: true, resetAt: NOW + (34 * 3600 + 23 * 60 + 28) * 1000 })
    expect(classifyFailure({ agent: 'antigravity', error: "Antigravity's quota is used up: RESOURCE_EXHAUSTED (code 429)" }, NOW)).toMatchObject({ kind: 'usage-limit', parsed: false })
    expect(classifyFailure({ agent: 'antigravity', error: 'panic: simulated agy failure\n\nagy exited with code 2' }, NOW).kind).toBe('transient')
    expect(classifyFailure({ agent: 'antigravity', error: 'Antigravity is not signed in. Run "agy" once in a terminal and sign in, then try again.' }, NOW).kind).toBe('permanent')
  })

  it('backs off 30 s then 120 s with ±20 % jitter, and waits 60 min / 2 h / 4 h for an unparsed limit', () => {
    expect(backoffDelay(0, () => 0)).toBe(24_000)
    expect(backoffDelay(0, () => 1)).toBe(36_000)
    expect(backoffDelay(1, () => 0.5)).toBe(120_000)
    expect(backoffDelay(5, () => 0.5)).toBe(120_000)
    expect(unparsedLimitWait(0)).toBe(60 * 60_000)
    expect(unparsedLimitWait(1)).toBe(120 * 60_000)
    expect(unparsedLimitWait(2)).toBe(240 * 60_000)
    expect(unparsedLimitWait(9)).toBe(240 * 60_000)
    expect(LIMIT_MARGIN_MS).toBe(120_000)
  })
})
