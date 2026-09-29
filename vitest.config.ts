import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests cover pure modules only (main-process logic, shared helpers, renderer state); no Electron runtime needed.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/renderer/src/**/*.test.ts']
  }
})
