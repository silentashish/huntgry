import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunSummary } from '@shared/runner-types'

// Every run.json write takes a while (a loaded CI disk): summaries queued before the process
// exits are still pending when its `close` arrives.
vi.mock('./runs', async (importOriginal) => {
  const real = await importOriginal<typeof import('./runs')>()
  return {
    ...real,
    saveRun: async (...args: Parameters<typeof real.saveRun>) => {
      await new Promise((r) => setTimeout(r, 60))
      return real.saveRun(...args)
    }
  }
})

const { RunManager } = await import('./runner')

const FAKE = join(__dirname, 'fixtures/fake-claude.mjs')
let ws: string
let runs: RunSummary[]
let manager: InstanceType<typeof RunManager>

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-runner-close-'))
  runs = []
  manager = new RunManager({ onEvent: () => undefined, onRun: (r) => runs.push(r) })
})
afterEach(async () => {
  manager.stopAll()
  await manager.whenIdle()
  await rm(ws, { recursive: true, force: true })
})

describe('RunManager: a process that exits right after its turn', () => {
  it('never broadcasts the terminal status before the turn’s output folder is recorded', async () => {
    const run = await manager.start(
      { jobDescription: 'BUILT_THEN_ERROR', company: 'Acme', role: 'Engineer', jobId: '42', coverLetter: false, dateStyle: 'right' },
      {
        workspace: ws,
        skillDir: '/skills/resume-tailor',
        sandbox: { workspace: ws, skillDir: '/skills/resume-tailor', venvDir: '/venv', texRoot: null },
        command: process.execPath,
        commandPrefixArgs: [FAKE],
        env: { ...process.env },
        systemPrompt: 'test'
      }
    )
    await manager.whenIdle()
    const mine = runs.filter((r) => r.id === run.id)
    expect(mine.at(-1)).toMatchObject({ status: 'failed' })
    expect(mine.at(-1)!.outputFiles).toContain('resume.pdf')
    // The queue acts on the first failed summary it sees: it must already carry the build.
    const firstFailed = mine.find((r) => r.status === 'failed')!
    expect(firstFailed.outputFiles).toContain('resume.pdf')
  })
})
