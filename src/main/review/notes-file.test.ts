import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasNotesV2, notesFileOf, parseResultNotes, readResultNotes } from './notes-file'

const V2 = '# Tailoring notes\n<!-- resume-tailor notes v2 -->\n\n## Reframings used\n### X\n- Source fact: a\n- Wording: b\n\n## Gaps left open\n- Go: never used\n'
const V1 = '# Review notes\n<!-- huntgry-review v1 · run r · unattended -->\n\n## Open gaps\n- Rust: nothing honest to say\n'
const FREE = '# Tailoring notes\n\nI kept the dates right-aligned.\n'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'huntgry-notes-file-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('notesFileOf / readResultNotes', () => {
  it('prefers tailoring-notes.md v2', async () => {
    await writeFile(join(dir, 'tailoring-notes.md'), V2)
    await writeFile(join(dir, 'review-notes.md'), V1)
    expect(await notesFileOf(dir)).toEqual({ file: 'tailoring-notes.md', format: 'v2' })
    const notes = await readResultNotes(dir)
    expect(notes?.text).toBe(V2)
    expect(parseResultNotes(notes!).openGaps).toEqual(['Go: never used'])
  })

  it('falls back to review-notes.md v1 when tailoring-notes.md is free-form (an older attended + unattended run)', async () => {
    await writeFile(join(dir, 'tailoring-notes.md'), FREE)
    await writeFile(join(dir, 'review-notes.md'), V1)
    expect(await hasNotesV2(dir)).toBe(false)
    expect(await notesFileOf(dir)).toEqual({ file: 'review-notes.md', format: 'v1' })
    expect(parseResultNotes((await readResultNotes(dir))!).openGaps).toEqual(['Rust: nothing honest to say'])
  })

  it('reads free-form tailoring-notes.md alone as v2 with a warning', async () => {
    await writeFile(join(dir, 'tailoring-notes.md'), FREE)
    const notes = await readResultNotes(dir)
    expect(notes).toMatchObject({ file: 'tailoring-notes.md', format: 'v2', text: FREE })
    expect(parseResultNotes(notes!).parseWarning).toMatch(/not in the v2 format/)
  })

  it('looks only at listed files, ignores directories and reports a file that is too large', async () => {
    await writeFile(join(dir, 'tailoring-notes.md'), V2)
    expect(await notesFileOf(dir, ['resume.pdf'])).toBeNull()
    await rm(join(dir, 'tailoring-notes.md'))
    await mkdir(join(dir, 'tailoring-notes.md'))
    expect(await notesFileOf(dir)).toBeNull()
    await writeFile(join(dir, 'review-notes.md'), V1)
    expect(await readResultNotes(dir, undefined, 10)).toMatchObject({ file: 'review-notes.md', text: null, tooLarge: Buffer.byteLength(V1) })
  })
})
