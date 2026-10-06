import { defineConfig } from 'vitest/config'

// Integration tests: the bundled Worker under Miniflare (workerd), driven from Node.
// Real alarms and timeouts, so budgets are generous; files run in sequence to share workerd's cold start.
export default defineConfig({
  test: {
    name: 'relay',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false
  }
})
