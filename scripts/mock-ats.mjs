#!/usr/bin/env node
/**
 * Local mock applicant tracking systems for testing auto-apply (#24) by hand,
 * so no real employer ever receives a test application.
 *
 *   node scripts/mock-ats.mjs            # http://localhost:4173/
 *   HUNTGRY_ALLOW_LOCAL_URLS=1 npm run dev
 *
 * Serves the committed form fixtures (src/shared/autofill/fixtures) at
 * /greenhouse/, /lever/ and /generic/. Pressing the page's own Submit button
 * posts to the mock, which records what it received to
 * <tmp>/huntgry-mock-ats/last-submission.json and shows the ATS's
 * confirmation page. Listens on 127.0.0.1 only. The routes live in
 * scripts/mock-ats/server.mjs, shared with the e2e suite; unit tests never use it.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockAts } from './mock-ats/server.mjs'

const port = Number(process.env.PORT ?? 4173)
const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '../src/shared/autofill/fixtures')
const { url, sites, submissionFile } = await startMockAts({ port, fixturesDir, log: console.log })
console.log(`[mock-ats] ${url}  (${sites.join(', ')}); submissions → ${submissionFile}`)
