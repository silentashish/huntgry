import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MAX_MATCH_LIST, type ApplicationMatch } from '@shared/applications-types'
import { profileSignals } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import type { MatchJob } from '@shared/match-score'
import { resumeCoverage, resumeEvidenceFromData, resumeEvidenceFromText, type ResumeEvidence } from '@shared/resume-coverage'
import { listJobs } from '../jobs/store'
import { readProfile } from '../profile/store'
import { extractPdf } from '../resume/pdf'
import { LEGACY_MASTER_PROFILE_FILE, MASTER_PROFILE_FILE } from '../workspace/constants'
import { resolveApplicationFolder } from './safe-path'
import { jobTitleOf, postingUrl } from './scan'
import { readTracking, updateTracking } from './tracking'

/**
 * The re-score after tailoring (#151): when a run's turn ends with a built resume, main scores the
 * resume against the job's requirements next to the master profile (`resumeCoverage`) and keeps the
 * numbers in the application's `huntgry.json` (`ApplicationTracking.match`). The skill's files are
 * only read.
 */

/** Largest `resume_data.json` / `build-report.json` / `job-description.md` read. */
const MAX_TEXT_BYTES = 512 * 1024
/** Largest `resume.pdf` read for its text. */
const MAX_PDF_BYTES = 10 * 1024 * 1024

/** A regular file of the folder (never a symlink), or `null` when it is missing or too large. */
async function readOwn(folder: string, file: string, max: number): Promise<Buffer | null> {
  try {
    const path = join(folder, file)
    const info = await lstat(path)
    if (!info.isFile() || info.size > max) return null
    return await readFile(path)
  } catch {
    return null
  }
}

/** The resume's words: `resume_data.json` (what the skill rendered), else the text of `resume.pdf`. */
export async function readResumeEvidence(folder: string): Promise<{ evidence: ResumeEvidence; from: ApplicationMatch['resumeFrom'] } | null> {
  const data = await readOwn(folder, 'resume_data.json', MAX_TEXT_BYTES)
  if (data) {
    try {
      const evidence = resumeEvidenceFromData(JSON.parse(data.toString('utf8')))
      if (evidence) return { evidence, from: 'resume_data.json' }
    } catch {
      // Not JSON: fall back to the PDF.
    }
  }
  const pdf = await readOwn(folder, 'resume.pdf', MAX_PDF_BYTES)
  if (!pdf) return null
  try {
    const evidence = resumeEvidenceFromText((await extractPdf(pdf)).map((l) => l.text).join('\n'))
    return evidence ? { evidence, from: 'resume.pdf' } : null
  } catch {
    return null
  }
}

/**
 * The skill's `jd_keyword_coverage` hint from `build-report.json`: the job-description terms its verify
 * step found absent from the resume ("31/40 substantive JD terms appear in the resume. Absent: ['Kafka', …]").
 */
export function absentTerms(report: string | null): string[] {
  if (!report) return []
  try {
    const results = (JSON.parse(report) as { verify?: { results?: unknown } }).verify?.results
    if (!Array.isArray(results)) return []
    const row = results.find((r) => (r as { check?: unknown })?.check === 'jd_keyword_coverage') as { detail?: unknown } | undefined
    const list = typeof row?.detail === 'string' ? /Absent:\s*\[(.*)\]\s*$/s.exec(row.detail)?.[1] : undefined
    if (!list) return []
    return [...list.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => (m[1] ?? m[2]).trim())
      .filter(Boolean)
      .slice(0, MAX_MATCH_LIST)
  } catch {
    return []
  }
}

/** The master profile of the workspace, under the current name or the older one. */
async function readWorkspaceProfile(workspace: string) {
  for (const name of [MASTER_PROFILE_FILE, LEGACY_MASTER_PROFILE_FILE]) {
    const doc = await readProfile(join(workspace, name)).catch(() => null)
    if (doc) return doc.profile
  }
  return null
}

/** The saved job the application was tailored for (the Board links them by URL), for its tags and board data. */
async function savedJob(workspace: string, url: string | null): Promise<Job | null> {
  if (!url) return null
  const jobs = await listJobs(workspace).catch(() => [] as Job[])
  return jobs.find((j) => j.url === url || j.boardUrl === url) ?? null
}

export interface RescoreOptions {
  runId?: string
  now?: Date
}

/**
 * Scores an application's resume (`resumeCoverage`) and stores the result as `huntgry.json` → `match`.
 * Returns what was stored: `null` (and any earlier `match` dropped) when the job names no requirement or
 * the resume can't be read; `null` without a write when there is no master profile or job description.
 */
export async function rescoreApplication(workspace: string, applicationId: string, opts: RescoreOptions = {}): Promise<ApplicationMatch | null> {
  const folder = await resolveApplicationFolder(workspace, applicationId)
  const [profile, jdBuf, report, tracking] = await Promise.all([
    readWorkspaceProfile(workspace),
    readOwn(folder, 'job-description.md', MAX_TEXT_BYTES),
    readOwn(folder, 'build-report.json', MAX_TEXT_BYTES),
    readTracking(folder)
  ])
  if (!profile || !jdBuf) return null
  const jd = jdBuf.toString('utf8')
  const saved = await savedJob(workspace, tracking.jobUrl ?? postingUrl(jd))
  // The description the skill tailored against; the saved job adds what only the board knows.
  const job: MatchJob = {
    title: saved?.title || jobTitleOf(jd),
    description: jd,
    tags: saved?.tags ?? [],
    minYearsExperience: saved?.minYearsExperience ?? null,
    visaSponsorship: saved?.visaSponsorship ?? null
  }
  const resume = await readResumeEvidence(folder)
  const r = resume ? resumeCoverage(job, profileSignals(profile, opts.now), resume.evidence) : null
  if (!resume || !r) {
    if (tracking.match) await updateTracking(folder, { match: undefined })
    return null
  }
  const match: ApplicationMatch = {
    profileFit: r.profileFit,
    resumeCoverage: r.resumeCoverage,
    requirements: r.requirements,
    leftOut: r.leftOut.slice(0, MAX_MATCH_LIST).map((s) => s.skill),
    resumeFrom: resume.from,
    source: r.source,
    at: (opts.now ?? new Date()).toISOString()
  }
  if (r.surfaced !== null) match.surfaced = r.surfaced
  const absent = absentTerms(report?.toString('utf8') ?? null)
  if (absent.length > 0) match.absent = absent
  if (r.gates.length > 0) match.gates = r.gates.map((g) => g.reason)
  if (opts.runId) match.runId = opts.runId
  return (await updateTracking(folder, { match })).match ?? null
}
