import type { MockAtsSite } from './server.mjs'

/** The job id of the mock embed (`/ashby/careers`) and its form page (`/ashby/<id>/application`). */
export const ASHBY_JOB_ID: string

/** An entry the mock Ashby adds to the mock ATS's `uploads.json`. */
export interface AshbyUpload {
  site: 'ashby'
  kind: 'upload' | 'parse'
  /** `'1'` when `?failUpload=1` made Ashby reject the upload. */
  fail?: '1'
  file: string
  type: string
  bytes: number
  sha256: string
  receivedAt: string
}

export function ashbySite(read: (name: string) => string): MockAtsSite
