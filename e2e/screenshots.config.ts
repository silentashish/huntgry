import { defineConfig } from '@playwright/test'

/**
 * Regenerates the README screenshots in docs/assets/screenshots/ (#132):
 * `npm run screenshots`. Same harness as the e2e suite (sandboxed app, fixture
 * workspaces with fictional people, fake agents, mock ATS), but kept out of
 * `npm run test:e2e`: it writes files into the repository on purpose.
 */
export default defineConfig({
  testDir: './screenshots',
  outputDir: './.results/screenshots-output',
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
  use: { actionTimeout: 15_000 }
})
