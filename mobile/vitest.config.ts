import { defineConfig } from 'vitest/config'

// The client modules (src/remote) are plain TypeScript: tests run in Node with a fake
// WebSocket, memory storage and a fake clock. Screens are checked by `expo export` + screenshots.
export default defineConfig({
  test: {
    name: 'mobile',
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
