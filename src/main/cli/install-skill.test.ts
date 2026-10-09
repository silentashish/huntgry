import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findSkillDir } from './env'
import {
  checkSkillUpdate,
  downloadSkillArchive,
  installSkill,
  parseRelease,
  readSkillArchive,
  readCapped,
  readSkillInstall,
  sha256Hex,
  syncSkill,
  type FetchLike
} from './install-skill'

const SKILL_MD = '---\nname: resume-tailor\ndescription: test\n---\n# Resume tailor\n'
const DL = 'https://github.com/silentashish/claude-resume-generator-skill/releases/download/v3/resume-tailor.skill'

function skillZip(extra: Zippable = {}, skillMd = SKILL_MD): Uint8Array {
  return zipSync({
    'resume-tailor': {},
    'resume-tailor/SKILL.md': strToU8(skillMd),
    'resume-tailor/scripts/build.py': strToU8('print("build")\n'),
    'resume-tailor/references/ats.md': strToU8('ats'),
    ...extra
  })
}

function release(zip: Uint8Array, digest: string | null = `sha256:${sha256Hex(zip)}`, tag = 'v3') {
  return {
    tag_name: tag,
    assets: [
      { name: 'other.zip', browser_download_url: 'https://example.com/x', size: 1 },
      { name: 'resume-tailor.skill', browser_download_url: DL, size: zip.byteLength, digest }
    ]
  }
}

/** A fetch that answers the release API and the download URL. */
function fakeFetch(json: unknown, zip: Uint8Array): FetchLike {
  return async (url) => {
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(json), { status: 200 })
    // `slice()` gives a Uint8Array over a plain ArrayBuffer, which is what BodyInit accepts.
    if (url === DL) return new Response(zip.slice(), { status: 200 })
    return new Response('not found', { status: 404 })
  }
}

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'huntgry-skill-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('skill release', () => {
  it('picks the skill asset and its digest', () => {
    const zip = skillZip()
    expect(parseRelease(release(zip))).toEqual({ tag: 'v3', url: DL, size: zip.byteLength, sha256: sha256Hex(zip) })
  })

  it('refuses a release whose asset has no or a malformed digest', () => {
    const zip = skillZip()
    expect(() => parseRelease(release(zip, null))).toThrow(/no sha256 digest/)
    expect(() => parseRelease(release(zip, 'sha256:abc'))).toThrow(/no sha256 digest/)
    expect(() => parseRelease(release(zip, `md5:${'0'.repeat(32)}`))).toThrow(/no sha256 digest/)
  })

  it('stops reading a body as soon as it passes the cap', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++
        c.enqueue(new Uint8Array(64 * 1024))
      }
    })
    await expect(readCapped(new Response(endless), 256 * 1024, 'too big')).rejects.toThrow('too big')
    expect(pulled).toBeLessThan(10)
  })

  it('rejects a release without the asset or pointing elsewhere', () => {
    expect(() => parseRelease({ tag_name: 'v4', assets: [] })).toThrow(/no resume-tailor.skill/)
    expect(() => parseRelease({ nope: 1 })).toThrow(/unexpected release/)
    const moved = release(skillZip())
    moved.assets[1].browser_download_url = 'https://evil.example/resume-tailor.skill'
    expect(() => parseRelease(moved)).toThrow(/somewhere unexpected/)
  })

  it('refuses an archive whose sha256 does not match the digest', async () => {
    const zip = skillZip()
    const r = parseRelease(release(zip, `sha256:${'0'.repeat(64)}`))
    await expect(downloadSkillArchive(r, fakeFetch({}, zip))).rejects.toThrow(/checksum/)
    expect(await downloadSkillArchive(parseRelease(release(zip)), fakeFetch({}, zip))).toEqual(zip)
  })
})

describe('skill archive', () => {
  it('reads the files under resume-tailor/', () => {
    const files = readSkillArchive(skillZip())
    expect([...files.keys()].sort()).toEqual([
      'resume-tailor/SKILL.md',
      'resume-tailor/references/ats.md',
      'resume-tailor/scripts/build.py'
    ])
  })

  it.each([
    ['resume-tailor/../evil.py'],
    ['../evil.py'],
    ['/etc/evil'],
    ['other-skill/SKILL.md'],
    ['resume-tailor\\..\\evil'],
    ['README.md']
  ])('rejects the entry %s', (name) => {
    expect(() => readSkillArchive(skillZip({ [name]: strToU8('x') }))).toThrow(/unexpected entry/)
  })

  it('rejects a SKILL.md for another skill, a missing one, and garbage', () => {
    expect(() => readSkillArchive(skillZip({}, '---\nname: other\n---\n'))).toThrow(/not the resume-tailor/)
    expect(() => readSkillArchive(zipSync({ 'resume-tailor/x.md': strToU8('x') }))).toThrow(/no resume-tailor\/SKILL.md/)
    expect(() => readSkillArchive(strToU8('not a zip'))).toThrow(/could not be read/)
  })

  it('refuses an archive that inflates past the size cap', () => {
    const big = new Uint8Array(51 * 1024 * 1024)
    expect(() => readSkillArchive(skillZip({ 'resume-tailor/big.bin': big }))).toThrow(/unexpectedly large/)
  })
})

describe('installSkill', () => {
  const opts = (fetchImpl: FetchLike, replace = false) => ({
    home: tmp,
    recordPath: join(tmp, 'userData/skill-install.json'),
    backupDir: join(tmp, 'userData/skill-backups'),
    fetchImpl,
    replace
  })

  it('installs into ~/.claude/skills/resume-tailor where findSkillDir finds it', async () => {
    const zip = skillZip()
    const log: string[] = []
    const res = await installSkill((l) => log.push(l), opts(fakeFetch(release(zip), zip)))
    const target = join(tmp, '.claude/skills/resume-tailor')
    expect(res).toEqual({ ok: true, tag: 'v3', path: target })
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    expect(await readFile(join(target, 'scripts/build.py'), 'utf8')).toContain('build')
    // No staging folder left behind.
    expect(await readdir(join(tmp, '.claude/skills'))).toEqual(['resume-tailor'])
    expect(await findSkillDir([join(tmp, '.claude/skills')])).toBe(target)
    expect(await readSkillInstall(join(tmp, 'userData/skill-install.json'))).toMatchObject({
      tag: 'v3',
      path: target,
      sha256: sha256Hex(zip)
    })
    expect(log.some((l) => l.includes('matches the release digest'))).toBe(true)
  })

  it('keeps an existing copy unless asked to replace it, then backs it up outside the skills folder', async () => {
    const zip = skillZip()
    const target = join(tmp, '.claude/skills/resume-tailor')
    await mkdir(target, { recursive: true })
    await writeFile(join(target, 'SKILL.md'), 'old')
    const kept = await installSkill(() => {}, opts(fakeFetch(release(zip), zip)))
    expect(kept.ok).toBe(false)
    expect(kept.error).toContain('Reinstall')
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe('old')

    const replaced = await installSkill(() => {}, opts(fakeFetch(release(zip), zip), true))
    expect(replaced.ok).toBe(true)
    expect(await readFile(join(target, 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    const backups = await readdir(join(tmp, 'userData/skill-backups'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(tmp, 'userData/skill-backups', backups[0], 'SKILL.md'), 'utf8')).toBe('old')
  })

  it('writes nothing when the archive is bad', async () => {
    const zip = skillZip({ 'resume-tailor/../../evil': strToU8('x') })
    const res = await installSkill(() => {}, opts(fakeFetch(release(zip), zip)))
    expect(res.ok).toBe(false)
    expect(await readdir(join(tmp, '.claude/skills')).catch(() => [])).toEqual([])
  })

  it('reports a rate limit', async () => {
    const res = await installSkill(() => {}, opts(async () => new Response('', { status: 403 })))
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('rate-limiting') })
  })
})

describe('syncSkill (#96)', () => {
  const opts = (fetchImpl: FetchLike) => ({
    home: tmp,
    recordPath: join(tmp, 'userData/skill-install.json'),
    backupDir: join(tmp, 'userData/skill-backups'),
    fetchImpl
  })
  const target = () => join(tmp, '.claude/skills/resume-tailor')

  it('installs when nothing is there', async () => {
    const zip = skillZip()
    const res = await syncSkill(() => {}, opts(fakeFetch(release(zip), zip)))
    expect(res).toMatchObject({ ok: true, tag: 'v3' })
    expect(res.upToDate).toBeUndefined()
    expect(await readFile(join(target(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
  })

  it('reports an older Huntgry install as outdated and updates it, keeping a backup', async () => {
    const v3 = skillZip()
    await installSkill(() => {}, opts(fakeFetch(release(v3), v3)))
    const v4md = SKILL_MD.replace('test', 'v4')
    const v4 = skillZip({}, v4md)
    const fetchV4 = fakeFetch(release(v4, undefined, 'v4'), v4)

    expect(await checkSkillUpdate(opts(fetchV4))).toEqual({ latest: 'v4', installed: 'v3', updateAvailable: true })
    const log: string[] = []
    const res = await syncSkill((l) => log.push(l), opts(fetchV4))
    expect(res).toMatchObject({ ok: true, tag: 'v4' })
    expect(log).toContain('Updating v3 → v4.')
    expect(await readFile(join(target(), 'SKILL.md'), 'utf8')).toBe(v4md)
    expect(await readdir(join(tmp, 'userData/skill-backups'))).toHaveLength(1)
    expect(await readSkillInstall(join(tmp, 'userData/skill-install.json'))).toMatchObject({ tag: 'v4' })
    expect(await checkSkillUpdate(opts(fetchV4))).toEqual({ latest: 'v4', installed: 'v4', updateAvailable: false })
  })

  it('leaves the latest release alone', async () => {
    const zip = skillZip()
    await installSkill(() => {}, opts(fakeFetch(release(zip), zip)))
    let downloads = 0
    const counting: FetchLike = async (url, init) => {
      if (url === DL) downloads++
      return fakeFetch(release(zip), zip)(url, init)
    }
    const res = await syncSkill(() => {}, opts(counting))
    expect(res).toMatchObject({ ok: true, tag: 'v3', upToDate: true })
    expect(downloads).toBe(0)
    expect(await readdir(join(tmp, 'userData/skill-backups')).catch(() => [])).toEqual([])
  })

  it('replaces a copy installed by hand (unknown version) and backs it up', async () => {
    await mkdir(target(), { recursive: true })
    await writeFile(join(target(), 'SKILL.md'), 'hand-made')
    const zip = skillZip()
    expect(await checkSkillUpdate(opts(fakeFetch(release(zip), zip)))).toEqual({
      latest: 'v3',
      installed: null,
      updateAvailable: true
    })
    const res = await syncSkill(() => {}, opts(fakeFetch(release(zip), zip)))
    expect(res.ok).toBe(true)
    expect(await readFile(join(target(), 'SKILL.md'), 'utf8')).toBe(SKILL_MD)
    const backups = await readdir(join(tmp, 'userData/skill-backups'))
    expect(await readFile(join(tmp, 'userData/skill-backups', backups[0], 'SKILL.md'), 'utf8')).toBe('hand-made')
  })

  it('keeps the current copy when GitHub fails', async () => {
    await mkdir(target(), { recursive: true })
    await writeFile(join(target(), 'SKILL.md'), 'old')
    const res = await syncSkill(() => {}, opts(async () => new Response('', { status: 429 })))
    expect(res).toMatchObject({ ok: false, error: expect.stringContaining('rate-limiting') })
    expect(await readFile(join(target(), 'SKILL.md'), 'utf8')).toBe('old')
  })
})
