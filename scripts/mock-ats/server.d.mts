import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One mock site: the form page (posting to the mock) and its confirmation page. */
export interface MockAtsSite {
  form(): string
  thanks: string
  thanksPage(): string
}

export interface MockAtsOptions {
  /** `src/shared/autofill/fixtures` (the module has no `import.meta`, so callers pass it). */
  fixturesDir: string
  /** `scripts/mock-ats/sites` (default: found from `fixturesDir`). */
  sitesDir?: string
  submissionFile?: string
  /** Where uploads to the mock S3 / résumé parser are recorded (default: uploads.json next to the submission file). */
  uploadsFile?: string
  /** The other origin /greenhouse/redirect-company sends to (default: the request's own). */
  otherOrigin?: () => string
  /** Sites served next to greenhouse, lever and generic (`/<name>/`, `/<name>/submit`, its `thanks` path). */
  extraSites?: Record<string, MockAtsSite>
  log?: (line: string) => void
}

export interface MockAts {
  submissionFile: string
  uploadsFile: string
  sites: string[]
  index(): string
  /** Answers the ATS routes; `false` when the path is not one of them. */
  handle(req: IncomingMessage, res: ServerResponse): boolean
}

export interface StartedMockAts {
  server: Server
  port: number
  url: string
  submissionFile: string
  uploadsFile: string
  sites: string[]
  close(): Promise<void>
}

export function defaultSubmissionFile(): string
export function mockAtsSites(read: (name: string) => string): Record<'greenhouse' | 'lever' | 'generic', MockAtsSite>
export function sendHtml(res: ServerResponse, status: number, body: string, headers?: Record<string, string>): void
export function recordSubmission(site: string, req: IncomingMessage, file: string): Promise<Record<string, unknown>>
export function recordUpload(site: string, req: IncomingMessage, file: string): Promise<Record<string, unknown>>
export function createMockAts(options: MockAtsOptions): MockAts
export function startMockAts(options: MockAtsOptions & { port?: number; host?: string }): Promise<StartedMockAts>
