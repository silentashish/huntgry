import type { IncomingMessage, ServerResponse } from 'node:http'

/** The mock posting's path (`/workday/job/…`), relative to the server's origin. */
export const WORKDAY_POSTING: string
/** Workday's dropdown and prompt widgets (browser code; tests run it with `window.eval(`(${workdayWidgets})()`)`). */
export function workdayWidgets(): void
export function createWorkdayMock(options: {
  read: (name: string) => string
  /** Records an upload request (the mock ATS's `recordUpload('workday', req, uploadsFile)`). */
  record: (req: IncomingMessage) => Promise<Record<string, unknown>>
  log: (line: string) => void
}): { handle(req: IncomingMessage, res: ServerResponse): boolean }
