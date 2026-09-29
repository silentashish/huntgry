import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readJobDescriptions } from './jobs'

let ws: string
beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'huntgry-graph-'))
})
afterEach(async () => {
  await rm(ws, { recursive: true, force: true })
})

describe('readJobDescriptions', () => {
  it('reads job-description.md of application folders only', async () => {
    for (const [rel, text] of [
      ['eng/acme/1', '# Backend Engineer\n\nPython and Kafka'],
      ['sre/globex/2', '\n**SRE, Platform**\nKubernetes'],
      ['.huntgry/runs/x', 'ignored'],
      ['eng/acme', 'wrong depth']
    ]) {
      await mkdir(join(ws, rel), { recursive: true })
      await writeFile(join(ws, rel, 'job-description.md'), text)
    }
    const jobs = await readJobDescriptions(ws)
    expect(jobs.map((j) => [j.id, j.title])).toEqual([
      ['eng/acme/1', 'Backend Engineer'],
      ['sre/globex/2', 'SRE, Platform']
    ])
    expect(jobs[0].text).toContain('Kafka')
  })

  it('reads at most 256 KB of a huge job description', async () => {
    await mkdir(join(ws, 'eng/big/1'), { recursive: true })
    await writeFile(join(ws, 'eng/big/1/job-description.md'), `# Big\n${'é'.repeat(400_000)}`)
    const [job] = await readJobDescriptions(ws)
    expect(Buffer.byteLength(job.text, 'utf8')).toBeLessThanOrEqual(256 * 1024)
    expect(job.text.endsWith('\uFFFD')).toBe(false)
  })
})
