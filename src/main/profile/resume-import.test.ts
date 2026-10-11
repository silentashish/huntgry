import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { droppedResumePath, importResumeFrom } from './resume-import'

let tmp: string
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-resume-import-')))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('droppedResumePath', () => {
  it('accepts an absolute path to a resume format, any case', () => {
    for (const name of ['cv.docx', 'cv.PDF', 'cv.txt', 'cv.md']) {
      expect(droppedResumePath(join(tmp, name))).toEqual({ ok: true, path: join(tmp, name) })
    }
  })

  it('refuses what is not a dropped file: empty (a File made by page script), relative, not a string', () => {
    for (const input of ['', 'cv.docx', './cv.docx', undefined, null, 42, { path: '/cv.docx' }]) {
      const result = droppedResumePath(input)
      expect(result.ok, String(input)).toBe(false)
    }
  })

  it('refuses other file types with the file name in the message', () => {
    const result = droppedResumePath(join(tmp, 'photo.png'))
    expect(result).toEqual({ ok: false, error: 'photo.png: Unsupported file type. Use .docx, .pdf, .txt or .md.' })
    expect(droppedResumePath(join(tmp, 'notes')).ok).toBe(false)
  })
})

describe('importResumeFrom', () => {
  it('parses a resume into a draft and names the file', async () => {
    const path = join(tmp, 'resume.md')
    await writeFile(path, '# Jordan Example\njordan.example@example.com\n\n## Summary\nBuilds things.\n')
    const result = await importResumeFrom(path)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.fileName).toBe('resume.md')
    expect(result.profile.contact.name).toBe('Jordan Example')
    expect(result.profile.contact.email).toBe('jordan.example@example.com')
  })

  it('reports an unreadable file as an error, not a cancel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await importResumeFrom(join(tmp, 'missing.docx'))
    expect(result).toMatchObject({ ok: false, cancelled: false })
    if (!result.ok) expect(result.error).toMatch(/^missing\.docx: /)
    vi.restoreAllMocks()
  })
})
