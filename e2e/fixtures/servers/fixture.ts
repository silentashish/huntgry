import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test as base } from '../app'
import { startMockServer, type MockServer } from './mock-server'

export { expect } from '../app'
export type { MockServer } from './mock-server'

/**
 * `test` for the Jobs, Browser and Apply specs: the `app` fixture plus a
 * mock server started once per worker on a free `127.0.0.1` port. Before
 * launch, the seeded workspace's `MOCK_ORIGIN` placeholders are rewritten to
 * that port (posting URLs in `huntgry.json` and saved jobs) and the app gets
 * the job-board overrides, so every board, posting and ATS the app reaches
 * is this server.
 */

/** What the `mocks` fixture workspace writes where a URL of the mock server belongs. */
export const MOCK_ORIGIN = 'http://mock-server.invalid'

/** Replaces `MOCK_ORIGIN` in every `.json` and `.md` file below `dir` with the server's origin. */
export async function rewriteMockUrls(dir: string, origin: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  for (const e of entries) {
    if (!e.isFile() || !/\.(json|md)$/.test(e.name)) continue
    const path = join(e.parentPath, e.name)
    const text = await readFile(path, 'utf8')
    if (text.includes(MOCK_ORIGIN)) await writeFile(path, text.replaceAll(MOCK_ORIGIN, origin))
  }
}

export const test = base.extend<{ mock: MockServer }, { mockServer: MockServer }>({
  mockServer: [
    async ({}, use) => {
      const dir = await mkdtemp(join(tmpdir(), 'huntgry-e2e-mock-'))
      const server = await startMockServer(join(dir, 'last-submission.json'))
      await use(server)
      await server.close()
      await rm(dir, { recursive: true, force: true })
    },
    { scope: 'worker' }
  ],
  // The same server, per test: the request log is cleared and the last submission removed.
  mock: async ({ mockServer }, use) => {
    mockServer.requests.length = 0
    await rm(mockServer.submissionFile, { force: true })
    await use(mockServer)
  },
  prepareWorkspace: async ({ mockServer }, use) => use((path) => rewriteMockUrls(path, mockServer.origin)),
  launchEnv: async ({ mockServer }, use) => use(mockServer.boardEnv())
})
