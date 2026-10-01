import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests drive the built Electron app (`out/main/index.js`), one
 * instance per test with its own userData, HOME and workspace copy (see
 * fixtures/app.ts and docs/testing/e2e.md). One worker: Electron windows on a
 * laptop and the mock servers later tickets add share ports and CPU.
 */
export default defineConfig({
  testDir: './tests',
  outputDir: './.results/test-output',
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: './.results/html-report' }]],
  use: {
    // Locally there are no retries, so a failure keeps its trace right away; in CI the retry records it.
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 15_000
  }
})
