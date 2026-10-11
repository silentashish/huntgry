import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RESUME_BYTES, resumeExtensionOf, type ResumeImportResult } from '@shared/master-profile'
import { buildDocx, buildPdf } from '../resume/test-fixtures'
import { importDroppedResume, importResumeFrom, isAppWindowTopFrame, type SenderEvent } from './resume-import'

let tmp: string
beforeEach(async () => {
  tmp = await realpath(await mkdtemp(join(tmpdir(), 'huntgry-resume-import-')))
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(tmp, { recursive: true, force: true })
})

const markdown = '# Jordan Example\njordan.example@example.com\n\n## Summary\nBuilds things.\n'

/** The same resume in every format the picked-file import reads. */
function samples(): Record<'docx' | 'pdf' | 'txt' | 'md', Buffer> {
  return {
    docx: buildDocx([{ runs: ['Jordan Example'] }, { runs: ['jordan.example@example.com'] }]),
    pdf: buildPdf([
      { x: 250, y: 750, text: 'JORDAN EXAMPLE', size: 14 },
      { x: 200, y: 732, text: 'jordan.example@example.com' }
    ]),
    txt: Buffer.from(markdown.replace(/^# /, '')),
    md: Buffer.from(markdown)
  }
}

const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

function expectJordan(result: ResumeImportResult, fileName: string) {
  expect(result.ok, JSON.stringify(result)).toBe(true)
  if (!result.ok) return
  expect(result.fileName).toBe(fileName)
  expect(result.profile.contact.name.toLowerCase()).toBe('jordan example')
  expect(result.profile.contact.email).toBe('jordan.example@example.com')
}

describe('importDroppedResume (bytes from the window, never a path)', () => {
  for (const [ext, buf] of Object.entries(samples())) {
    it(`parses a dropped .${ext}`, async () => {
      expectJordan(await importDroppedResume({ name: `resume.${ext}`, bytes: bytes(buf) }), `resume.${ext}`)
    })
  }

  it('takes the extension from the name only, case-insensitively, and accepts an ArrayBuffer', async () => {
    const md = samples().md
    const ab = md.buffer.slice(md.byteOffset, md.byteOffset + md.byteLength)
    expectJordan(await importDroppedResume({ name: 'CV.MD', bytes: ab }), 'CV.MD')
  })

  it('refuses a name without an allowed extension, whatever the bytes are', async () => {
    for (const name of ['photo.png', 'resume', 'resume.doc', 'resume.md.exe', '.bashrc']) {
      const result = await importDroppedResume({ name, bytes: bytes(samples().md) })
      expect(result, name).toEqual({
        ok: false,
        cancelled: false,
        error: `${name}: Unsupported file type. Use .docx, .pdf, .txt or .md.`
      })
    }
  })

  it('refuses more than the size cap without parsing', async () => {
    const result = await importDroppedResume({ name: 'big.txt', bytes: new Uint8Array(MAX_RESUME_BYTES + 1) })
    expect(result).toEqual({ ok: false, cancelled: false, error: 'big.txt: The file is larger than 20 MB.' })
  })

  it('refuses anything that is not { name, bytes }: a path string is never opened', async () => {
    const onDisk = join(tmp, 'resume.md')
    await writeFile(onDisk, markdown)
    for (const input of [onDisk, { path: onDisk }, { name: 'resume.md' }, { name: 'resume.md', bytes: onDisk }, { name: 1, bytes: new Uint8Array() }, null, undefined]) {
      const result = await importDroppedResume(input)
      expect(result, JSON.stringify(input)).toEqual({ ok: false, cancelled: false, error: 'The dropped file could not be read.' })
    }
  })

  it('uses only the last part of a name that looks like a path, for messages', async () => {
    const result = await importDroppedResume({ name: '../../etc/passwd.docx', bytes: bytes(Buffer.from('not a zip')) })
    expect(result).toEqual({ ok: false, cancelled: false, error: 'passwd.docx: The file does not look like a valid .docx.' })
  })

  it('reports bytes that do not match the extension as an error, not a cancel', async () => {
    const result = await importDroppedResume({ name: 'resume.pdf', bytes: bytes(Buffer.from('plain text')) })
    expect(result).toEqual({ ok: false, cancelled: false, error: 'resume.pdf: The file does not look like a valid .pdf.' })
  })
})

describe('importResumeFrom (a path main chose in the native dialog)', () => {
  it('parses each supported format from disk', async () => {
    for (const [ext, buf] of Object.entries(samples())) {
      const path = join(tmp, `resume.${ext}`)
      await writeFile(path, buf)
      expectJordan(await importResumeFrom(path), `resume.${ext}`)
    }
  })

  it('reports an unreadable file as an error, not a cancel', async () => {
    const result = await importResumeFrom(join(tmp, 'missing.docx'))
    expect(result).toMatchObject({ ok: false, cancelled: false })
    if (!result.ok) expect(result.error).toMatch(/^missing\.docx: /)
  })
})

describe('isAppWindowTopFrame', () => {
  const top = { processId: 4, routingId: 1 }
  const app = { mainFrame: top }

  it('accepts the top frame of the app window', () => {
    expect(isAppWindowTopFrame({ sender: app, senderFrame: { processId: 4, routingId: 1 } }, app)).toBe(true)
  })

  it('refuses another webContents (an in-app browser tab), a subframe, a missing frame or no window', () => {
    const tab = { mainFrame: { processId: 9, routingId: 1 } }
    const cases: Array<[SenderEvent, typeof app | undefined]> = [
      [{ sender: tab, senderFrame: tab.mainFrame }, app], // a job site tab, whatever window it sits in
      [{ sender: tab, senderFrame: tab.mainFrame }, undefined], // a tab with no window of its own
      [{ sender: app, senderFrame: { processId: 4, routingId: 7 } }, app], // an iframe in the app window
      [{ sender: app, senderFrame: null }, app], // frame already gone
      [{ sender: app, senderFrame: top }, undefined]
    ]
    for (const [event, contents] of cases) expect(isAppWindowTopFrame(event, contents)).toBe(false)
  })
})

describe('resumeExtensionOf', () => {
  it('returns the allow-listed extension in lower case, or null', () => {
    expect(resumeExtensionOf('a.DOCX')).toBe('docx')
    expect(resumeExtensionOf('a.b.pdf')).toBe('pdf')
    expect(resumeExtensionOf('notes.txt')).toBe('txt')
    expect(resumeExtensionOf('readme.md')).toBe('md')
    for (const name of ['a.png', 'md', 'a.', 'a.docx.zip', '']) expect(resumeExtensionOf(name), name).toBeNull()
  })
})
