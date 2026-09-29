import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests target the pure workspace module only; no Electron runtime needed.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  test: {
    environment: 'node',
    include: ['src/main/**/*.test.ts']
  }
})
