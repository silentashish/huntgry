import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests cover pure modules only (main-process logic, shared helpers, renderer state); no Electron runtime needed.
export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared') } },
  // Renderer component tests render to static markup (react-dom/server); the JSX runtime is the automatic one.
  esbuild: { jsx: 'automatic' },
  test: {
    environment: 'node',
    // e2e/fixtures: the scripted agent CLIs are checked against the adapters' event shapes here; the suite itself is Playwright.
    include: ['src/main/**/*.test.ts', 'src/shared/**/*.test.ts', 'src/renderer/src/**/*.test.{ts,tsx}', 'e2e/fixtures/**/*.test.ts']
  }
})
