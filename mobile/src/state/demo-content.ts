/**
 * Demo data for the Jobs, Review, Files and Pipeline screens (#40, #41, #42): the Figma
 * frames' sample jobs and reframings, three results to review, and small SVG "pages" standing
 * in for the JPEG previews a Mac sends (rendered only in demo mode). Every file has a real
 * SHA-256, so the demo goes through the same reassembly and hash check as a real Mac.
 */

import type { PipelineState, RemoteFile, RemoteJob, ReviewDetail, ReviewItem } from '@huntgry/remote-protocol'
import { sha256Hex } from '../remote/files'

const enc = (text: string) => new TextEncoder().encode(text)

const INK300 = '#8494a8'
const INK100 = '#d9e0e8'

/** A page in the Figma preview's style: a name, then section bars and lines. */
function pageSvg(name: string, sub: string, seed: number, accent: string): string {
  const rows: string[] = []
  let y = 40
  for (let s = 0; s < 4; s++) {
    rows.push(`<rect x="10" y="${y}" width="${50 + ((seed + s) % 3) * 8}" height="4" rx="2" fill="${INK300}"/>`)
    y += 9
    for (let l = 0; l < 4; l++) {
      const w = 96 + ((seed * 7 + s * 5 + l * 11) % 44)
      rows.push(`<rect x="10" y="${y}" width="${w}" height="3" rx="1.5" fill="${INK100}"/>`)
      y += 7
    }
    y += 6
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 200"><rect width="160" height="200" fill="#ffffff"/><text x="10" y="18" font-family="Helvetica, Arial, sans-serif" font-size="10" font-weight="700" fill="#0b0f15">${name}</text><text x="10" y="29" font-family="Helvetica, Arial, sans-serif" font-size="5.5" fill="${accent}">${sub}</text>${rows.join('')}</svg>`
}

const PDF = (title: string) =>
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 60>>stream\nBT /F1 24 Tf 72 700 Td (${title} - Huntgry demo) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n`

export interface DemoResult {
  item: ReviewItem
  files: Partial<Record<RemoteFile, Uint8Array>>
  detail: Omit<ReviewDetail, 'artifacts' | 'revision'>
}

function artifactsOf(files: DemoResult['files']): ReviewDetail['artifacts'] {
  return (Object.keys(files) as RemoteFile[]).filter((f) => f !== 'review-notes.md').map((file) => ({ file, bytes: files[file]!.length, sha256: sha256Hex(files[file]!) }))
}

/** The detail as a Mac would serve it: artifacts with their hashes, and a revision over all of it. */
export function served(r: DemoResult, state: ReviewDetail['state'] = r.detail.state): ReviewDetail {
  const artifacts = artifactsOf(r.files)
  const revision = sha256Hex(enc(JSON.stringify({ ...r.detail, state, artifacts })))
  return { ...r.detail, state, artifacts, revision }
}

const id = (text: string) => sha256Hex(enc(text))
const reframing = (sourceFact: string, wording: string) => ({ id: id(`${sourceFact}\n${wording}`), sourceFact, wording })

export function demoResults(now: number): DemoResult[] {
  const at = (min: number) => new Date(now - min * 60_000).toISOString()
  const figma = 'em-platform/figma/url-6f1d0c2a9b3e4d57'
  const stripe = 'senior-backend-engineer/stripe/url-0a7c5e91d2b84f36'
  const datadog = 'staff-engineer-infra/datadog/url-93be27d40c1f5a68'
  return [
    {
      item: { applicationId: figma, runId: 'run-figma', title: 'Figma · EM, Platform', openGaps: 2, finishedAt: at(12), state: 'unreviewed' },
      files: {
        'resume.pdf': enc(PDF('Ashish - EM, Platform')),
        'cover.pdf': enc(PDF('Ashish - Cover letter, Figma')),
        'resume-page-1.jpg': enc(pageSvg('Ashish Gautam', 'Engineering Manager · Platform', 1, '#e66e0a')),
        'resume-page-2.jpg': enc(pageSvg('Experience, cont.', 'Platform · Developer tools', 4, '#e66e0a')),
        'cover-page-1.jpg': enc(pageSvg('Dear Figma team,', 'EM, Platform · cover letter', 2, '#0e9e85'))
      },
      detail: {
        applicationId: figma,
        runId: 'run-figma',
        title: 'Figma · EM, Platform',
        reviewNotes: '## Direct hits\n- Platform team leadership (Huntgry, 2023–)\n- Electron desktop shell\n\n## Open gaps\n- Design-tool domain experience\n- Managing managers\n\n## Proposed reframings\n- R1 · Managed a platform team of 6+ → Led a 4-person platform team that shipped the desktop shell to 120k users\n- R2 · Owned on-call → Owned the on-call rotation and incident reviews',
        openGaps: ['Design-tool domain experience', 'Managing managers'],
        proposedReframings: [reframing('Managed a platform team of 6+', 'Led a 4-person platform team that shipped the desktop shell to 120k users'), reframing('Owned on-call', 'Owned the on-call rotation and incident reviews')],
        verify: { ok: true, report: '{\n  "status": "pass",\n  "pages": 2,\n  "ats": { "parsable": true, "keywords": 0.82 },\n  "warnings": []\n}' },
        state: 'unreviewed'
      }
    },
    {
      item: { applicationId: stripe, runId: 'run-stripe-2', title: 'Stripe · Senior Backend Engineer', openGaps: 1, finishedAt: at(34), state: 'unreviewed' },
      files: {
        'resume.pdf': enc(PDF('Ashish - Senior Backend Engineer')),
        'resume-page-1.jpg': enc(pageSvg('Ashish Gautam', 'Senior Backend Engineer · Payments', 3, '#e66e0a'))
      },
      detail: {
        applicationId: stripe,
        runId: 'run-stripe-2',
        title: 'Stripe · Senior Backend Engineer',
        reviewNotes: '## Open gaps\n- gRPC in production',
        openGaps: ['gRPC in production'],
        proposedReframings: [reframing('Built a Kafka pipeline', 'Built an SQS / SNS event pipeline for billing events')],
        verify: { ok: true, report: '{ "status": "pass", "pages": 1 }' },
        state: 'unreviewed'
      }
    },
    {
      item: { applicationId: datadog, runId: 'run-datadog', title: 'Datadog · Staff Engineer, Infra', openGaps: 3, finishedAt: at(80), state: 'needs-attention', reason: 'verify.py failed: the resume runs to 3 pages.' },
      files: {
        'resume.pdf': enc(PDF('Ashish - Staff Engineer, Infra')),
        'resume-page-1.jpg': enc(pageSvg('Ashish Gautam', 'Staff Engineer · Infrastructure', 5, '#e66e0a'))
      },
      detail: {
        applicationId: datadog,
        runId: 'run-datadog',
        title: 'Datadog · Staff Engineer, Infra',
        reviewNotes: '## Open gaps\n- Go\n- Kubernetes operators\n- On-call at scale',
        openGaps: ['Go', 'Kubernetes operators', 'On-call at scale'],
        proposedReframings: [],
        verify: { ok: false, report: '{ "status": "fail", "failed": ["page-count"], "pages": 3 }' },
        state: 'needs-attention',
        reason: 'verify.py failed: the resume runs to 3 pages.'
      }
    }
  ]
}

export function demoJobs(now: number): RemoteJob[] {
  const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
  const rows: [string, string, string, string, boolean?, boolean?][] = [
    ['url:3a9f0c7d1e2b4c58', 'Senior Backend Engineer, Payments', 'Stripe', 'Remote', true],
    ['url:7b2e4f1a9c0d3e65', 'Staff Software Engineer, Infra', 'Anthropic', 'SF Hybrid', true],
    ['url:1c8d5e2f0a9b7c43', 'Product Engineer, Growth', 'Notion', 'NYC'],
    ['url:5e0a3b9c7d1f2e84', 'Platform Engineer', 'Linear', 'Remote'],
    ['url:9d4c1b8a2e7f0c36', 'Senior Frontend, Editor', 'Figma', 'SF'],
    ['url:2f6e9d0c4b3a1e57', 'EM, Platform', 'Figma', 'SF', true],
    ['url:8a1b7c3d5e9f2a40', 'Backend Engineer', 'Ramp', 'NYC'],
    ['url:4c7e2a0b9d1f5c63', 'Staff Engineer, Infra', 'Datadog', 'Remote', true],
    ['url:6b3d8f1e0c2a7d95', 'Senior Engineer, Sync', 'Linear', 'Remote', false, true]
  ]
  return rows.map(([id, title, company, location, tailored, dismissed], i) => ({ id, title, company, location, source: 'url', savedAt: at(i * 5 + 1), ...(tailored ? { tailored } : {}), ...(dismissed ? { dismissed } : {}) }))
}

/** The pipeline of the Figma frame: 20 jobs, 5 built; `limit` = waiting for Claude's limit until 14:05. */
export function demoPipeline(now: number, limit: boolean): PipelineState {
  const reset = new Date(now)
  reset.setHours(14, 5, 0, 0)
  const base: PipelineState = {
    status: 'running',
    agent: 'claude',
    counts: { total: 20, done: 5, running: 3, queued: 12, failed: 0, unreviewed: 2, needsAttention: 1 },
    eta: new Date(now + 40 * 60_000).toISOString(),
    startedAt: new Date(now - 50 * 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString()
  }
  if (!limit) return base
  return { ...base, status: 'waiting-limit', counts: { ...base.counts, running: 0, queued: 12 }, waitingLimitUntil: reset.toISOString(), reason: 'Claude usage limit reached. Resets at 2:05 pm.' }
}
