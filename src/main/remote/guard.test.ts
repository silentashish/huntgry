import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REMOTE_COMMAND_NAMES, requireCommand } from '@shared/remote'

/**
 * The remote allow-list stays closed (ADR-0001, "Command allow-list and rules"): nothing a
 * phone can send opens the in-app browser, fills or submits an application, installs or
 * updates a CLI, switches workspace, edits the profile, opens files or chooses the default
 * agent, and no argument is a path, a command line, a model or a flag. In the spirit of
 * #24's guard test: this fails the build, it does not warn.
 */

const FORBIDDEN_WORDS = ['apply', 'browser', 'workspace', 'profile', 'install', 'update', 'link', 'open', 'reveal', 'setDefaultAgent', 'autofill', 'submit', 'exec', 'shell', 'spawn']

/** Argument names a command may carry; anything else is a new surface that needs this test changed on purpose. */
const ALLOWED_ARG_KEYS = new Set([
  'paused', 'itemId', 'jobIds', 'options', 'concurrency', 'agent', 'fallback', 'budget', 'filter', 'cursor', 'url', 'runId', 'sinceSeq', 'text', 'applicationId', 'revision', 'approvedReframingIds', 'answers', 'file', 'chunk', 'categories'
])
const FORBIDDEN_ARG_WORDS = /path|cwd|dir|folder|command|cmd|argv|args$|flag|model|tool|setting|permission|env|prompt|script|binary|exec/i

/** Every allow-listed command with valid arguments, to see which argument names the guard accepts. */
const SAMPLES: Record<string, unknown> = {
  'queue.setPaused': { paused: true },
  'queue.cancel': { itemId: 'q-1' },
  'queue.retry': { itemId: 'q-1' },
  'queue.enqueue': { jobIds: ['url:a'], options: { coverLetter: true, dateStyle: 'inline', notes: 'n' }, concurrency: 2, agent: 'claude' },
  'pipeline.start': { jobIds: ['url:a'], concurrency: 1, agent: 'claude', fallback: 'codex', budget: { maxCostUsd: 1, maxRuns: 1 }, options: { coverLetter: true, dateStyle: 'right' } },
  'jobs.list': { filter: 'x', cursor: 'c' },
  'jobs.addUrl': { url: 'https://jobs.example.com/1' },
  'runs.list': { cursor: 'c' },
  'run.get': { runId: 'r', sinceSeq: 1 },
  'run.reply': { runId: 'r', text: 'hi' },
  'run.finish': { runId: 'r' },
  'run.stop': { runId: 'r' },
  'review.get': { applicationId: 'a/b/c' },
  'review.approve': { applicationId: 'a/b/c', revision: 'r', approvedReframingIds: ['x'] },
  'review.rerun': { runId: 'r', revision: 'r', answers: 'a' },
  'review.discard': { applicationId: 'a/b/c', revision: 'r' },
  'file.get': { applicationId: 'a/b/c', file: 'resume.pdf', chunk: 0 },
  'device.setNotifications': { categories: ['failed'] }
}

describe('remote allow-list', () => {
  it('contains no apply, browser, workspace, profile, install, update, link, open, reveal or setDefaultAgent command', () => {
    for (const name of REMOTE_COMMAND_NAMES) {
      for (const word of FORBIDDEN_WORDS) expect(name.toLowerCase(), name).not.toContain(word.toLowerCase())
    }
  })

  it('has a known, closed set of prefixes', () => {
    const prefixes = new Set(REMOTE_COMMAND_NAMES.map((n) => n.split('.')[0]))
    expect([...prefixes].sort()).toEqual(['device', 'file', 'jobs', 'pipeline', 'queue', 'review', 'run', 'runs', 'status'])
  })

  it('takes no argument that is a path, command line, model, flag, tool or setting', () => {
    for (const name of REMOTE_COMMAND_NAMES) {
      const sample = SAMPLES[name]
      const parsed = requireCommand(name, sample) as { args?: Record<string, unknown> }
      const keys = Object.keys(parsed.args ?? {})
      for (const key of keys) {
        expect(ALLOWED_ARG_KEYS.has(key), `${name}.${key}`).toBe(true)
        expect(key, `${name}.${key}`).not.toMatch(FORBIDDEN_ARG_WORDS)
      }
      // Nested objects too (options, budget).
      for (const [key, value] of Object.entries(parsed.args ?? {})) {
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          for (const inner of Object.keys(value)) expect(inner, `${name}.${key}.${inner}`).not.toMatch(FORBIDDEN_ARG_WORDS)
        }
      }
    }
  })

  it('the gateway dispatches only through requireCommandEnvelope and the shared validators', () => {
    const source = readFileSync(join(__dirname, 'gateway.ts'), 'utf8')
    expect(source).toContain('requireCommandEnvelope(envelope)')
    for (const validator of ['requireRunId', 'requireItemId', 'requireEnqueueInput', 'assertPublicUrl', 'MAX_TEXT']) expect(source).toContain(validator)
    // Never the forbidden services.
    for (const forbidden of ['shell.', 'openPath', 'showItemInFolder', 'installClaude', 'updateClaude', 'installSkill', 'setDefaultAgent', 'ApplyService', 'attachBrowser', 'openWorkspace', 'createWorkspace', 'saveProfile', 'spawn(']) {
      expect(source, forbidden).not.toContain(forbidden)
    }
  })

  it('the session makes outbound connections only (no listening socket, no http server)', () => {
    for (const file of ['session.ts', 'ipc.ts', 'gateway.ts', 'credentials.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(source, file).not.toMatch(/createServer|\.listen\(|WebSocketServer|node:net|node:http\b/)
    }
    const creds = readFileSync(join(__dirname, 'credentials.ts'), 'utf8')
    expect(creds).toContain("redirect: 'error'")
    expect(creds).toContain("url.protocol !== 'https:'")
  })
})
