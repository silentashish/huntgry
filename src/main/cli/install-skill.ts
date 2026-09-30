import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { unzipSync } from 'fflate'
import { SKILL_ASSET, SKILL_NAME, SKILL_REPO } from '../workspace/constants'

/**
 * Installs the resume-tailor skill from the latest GitHub release of its repo
 * into `~/.claude/skills/resume-tailor`, the personal skills folder that
 * `findSkillDir` checks first. The archive's sha256 must match the release
 * asset's digest, and every zip entry is checked before anything is written.
 */

export interface SkillRelease {
  tag: string
  url: string
  size: number
  /** Hex digest from the release asset, `null` when GitHub did not publish one. */
  sha256: string | null
}

/** What Huntgry installed, kept in `<userData>/skill-install.json`. */
export interface SkillInstallRecord {
  tag: string
  sha256: string
  installedAt: string
  path: string
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_ENTRIES = 500
const MAX_EXTRACTED_BYTES = 50 * 1024 * 1024
const API_TIMEOUT_MS = 15_000
const DOWNLOAD_TIMEOUT_MS = 60_000

export const SKILL_RELEASES_PAGE = `https://github.com/${SKILL_REPO}/releases`
const LATEST_RELEASE_API = `https://api.github.com/repos/${SKILL_REPO}/releases/latest`
const DOWNLOAD_PREFIX = `https://github.com/${SKILL_REPO}/releases/download/`

/** Picks the skill asset out of a `GET /releases/latest` response. */
export function parseRelease(json: unknown): SkillRelease {
  const r = (typeof json === 'object' && json !== null ? json : {}) as {
    tag_name?: unknown
    assets?: unknown
  }
  if (typeof r.tag_name !== 'string' || !Array.isArray(r.assets)) throw new Error('GitHub returned an unexpected release.')
  const asset = (r.assets as Record<string, unknown>[]).find((a) => a?.name === SKILL_ASSET)
  if (!asset) throw new Error(`The latest release (${r.tag_name}) has no ${SKILL_ASSET}.`)
  const url = asset.browser_download_url
  if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX))
    throw new Error('The release asset points somewhere unexpected.')
  const size = typeof asset.size === 'number' ? asset.size : 0
  if (size > MAX_ARCHIVE_BYTES) throw new Error('The skill archive is unexpectedly large.')
  const digest = typeof asset.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null
  return { tag: r.tag_name, url, size, sha256: digest ? digest[1].toLowerCase() : null }
}

export async function latestSkillRelease(fetchImpl: FetchLike = fetch): Promise<SkillRelease> {
  const res = await fetchImpl(LATEST_RELEASE_API, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'Huntgry' },
    signal: AbortSignal.timeout(API_TIMEOUT_MS)
  })
  if (res.status === 403 || res.status === 429)
    throw new Error('GitHub is rate-limiting requests from this network. Try again in an hour.')
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the latest skill release.`)
  return parseRelease(await res.json())
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer())
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel()
      throw new Error('The skill archive is unexpectedly large.')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.byteLength
  }
  return out
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Downloads the archive; a digest mismatch is an error. */
export async function downloadSkillArchive(release: SkillRelease, fetchImpl: FetchLike = fetch): Promise<Uint8Array> {
  const res = await fetchImpl(release.url, {
    headers: { 'user-agent': 'Huntgry' },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Downloading the skill failed (${res.status}).`)
  const bytes = await readCapped(res, MAX_ARCHIVE_BYTES)
  if (release.sha256 && sha256Hex(bytes) !== release.sha256)
    throw new Error('The downloaded skill does not match the checksum GitHub published. Nothing was installed.')
  return bytes
}

/** A safe relative path below `resume-tailor/`, or an error naming the entry. */
function checkEntryName(name: string): void {
  const bad = () => new Error(`The skill archive has an unexpected entry: ${JSON.stringify(name.slice(0, 200))}`)
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/')) throw bad()
  const parts = name.replace(/\/$/, '').split('/')
  if (parts[0] !== SKILL_NAME || parts.some((p) => p === '' || p === '.' || p === '..')) throw bad()
}

/**
 * Unzips and validates the archive: every entry under `resume-tailor/`, no
 * `..`, absolute paths or backslashes, bounded entry count and size, and a
 * `SKILL.md` whose frontmatter names the skill. Returns files by relative path.
 */
export function readSkillArchive(zip: Uint8Array): Map<string, Uint8Array> {
  let count = 0
  let total = 0
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(zip, {
      // Runs before each entry is inflated, so a zip bomb is refused up front.
      filter: (file) => {
        checkEntryName(file.name)
        if (++count > MAX_ENTRIES) throw new Error('The skill archive has too many files.')
        total += file.originalSize
        if (total > MAX_EXTRACTED_BYTES) throw new Error('The skill archive is unexpectedly large.')
        return true
      }
    })
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('The skill archive')) throw err
    throw new Error(`The skill archive could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
  const files = new Map<string, Uint8Array>()
  for (const [name, data] of Object.entries(entries)) {
    if (!name.endsWith('/')) files.set(name, data)
  }
  const skillMd = files.get(`${SKILL_NAME}/SKILL.md`)
  if (!skillMd) throw new Error(`The skill archive has no ${SKILL_NAME}/SKILL.md.`)
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(new TextDecoder().decode(skillMd))
  if (!frontmatter || !new RegExp(`^name:\\s*["']?${SKILL_NAME}["']?\\s*$`, 'm').test(frontmatter[1]))
    throw new Error(`SKILL.md in the archive is not the ${SKILL_NAME} skill.`)
  return files
}

/** Writes validated files below `destDir` (creating `destDir/resume-tailor/…`). */
export async function writeSkillFiles(files: Map<string, Uint8Array>, destDir: string): Promise<void> {
  for (const [name, data] of files) {
    const path = join(destDir, ...name.split('/'))
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { mode: 0o644 })
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** Moves a folder, copying when the target is on another volume. */
async function move(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await cp(from, to, { recursive: true })
    await rm(from, { recursive: true, force: true })
  }
}

export async function readSkillInstall(recordPath: string): Promise<SkillInstallRecord | null> {
  try {
    const r = JSON.parse(await readFile(recordPath, 'utf8')) as Partial<SkillInstallRecord>
    return typeof r.tag === 'string' && typeof r.path === 'string' && typeof r.installedAt === 'string'
      ? { tag: r.tag, path: r.path, installedAt: r.installedAt, sha256: String(r.sha256 ?? '') }
      : null
  } catch {
    return null
  }
}

export interface InstallSkillOptions {
  home: string
  /** `<userData>/skill-install.json`. */
  recordPath: string
  /** Where a replaced copy is moved (outside ~/.claude/skills, so Claude Code never loads it twice). */
  backupDir: string
  /** Replace an existing `~/.claude/skills/resume-tailor` (Reinstall). */
  replace?: boolean
  fetchImpl?: FetchLike
}

export async function installSkill(
  log: (line: string) => void,
  opts: InstallSkillOptions
): Promise<{ ok: boolean; error?: string; tag?: string; path?: string }> {
  const skillsDir = join(opts.home, '.claude', 'skills')
  const target = join(skillsDir, SKILL_NAME)
  let staging: string | null = null
  try {
    if ((await exists(target)) && !opts.replace)
      return { ok: false, error: `The skill is already installed at ${target}. Use Reinstall to replace it.` }

    log(`Looking up the latest release of ${SKILL_REPO}…`)
    const release = await latestSkillRelease(opts.fetchImpl)
    log(`Release ${release.tag}: ${SKILL_ASSET} (${release.size.toLocaleString()} bytes)`)
    const zip = await downloadSkillArchive(release, opts.fetchImpl)
    const sha256 = sha256Hex(zip)
    log(release.sha256 ? `sha256 ${sha256} matches the release digest.` : `sha256 ${sha256} (GitHub published no digest).`)

    const files = readSkillArchive(zip)
    log(`${files.size} files checked.`)

    await mkdir(skillsDir, { recursive: true })
    // Staged next to the target (same volume) so the final step is one rename. The dot keeps it out of findSkillDir.
    staging = await mkdtemp(join(skillsDir, `.${SKILL_NAME}-`))
    await writeSkillFiles(files, staging)

    if (await exists(target)) {
      await mkdir(opts.backupDir, { recursive: true })
      const backup = join(opts.backupDir, `${SKILL_NAME}-${new Date().toISOString().replace(/[:.]/g, '-')}`)
      await move(target, backup)
      log(`Moved the previous copy to ${backup}`)
    }
    await rename(join(staging, SKILL_NAME), target)
    log(`Installed to ${target}`)

    const record: SkillInstallRecord = { tag: release.tag, sha256, installedAt: new Date().toISOString(), path: target }
    await mkdir(dirname(opts.recordPath), { recursive: true })
    await writeFile(opts.recordPath, `${JSON.stringify(record, null, 2)}\n`)
    log('Done.')
    return { ok: true, tag: release.tag, path: target }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log(message)
    return { ok: false, error: message }
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
  }
}
