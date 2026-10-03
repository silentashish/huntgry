import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MockAtsSite } from './server.mjs'

/** `ashby-uploads.json` beside the submission file: one entry per upload or parse the mock Ashby received. */
export function ashbyUploadsFile(submissionFile: string): string

export interface AshbyUpload {
  kind: 'upload' | 'parse'
  file: string
  type: string
  bytes: number
  at: string
}

export function ashbySite(read: (name: string) => string): MockAtsSite & {
  routes(action: string, req: IncomingMessage, res: ServerResponse, ctx: { submissionFile: string; sendJson(res: ServerResponse, status: number, body: unknown): void }): boolean
}
