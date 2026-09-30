import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  preload: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    build: {
      // Sandboxed preloads cannot require sibling chunks, so the two entries must not share a runtime module:
      // browser-page imports only src/shared/autofill/*, autofill-channels.ts and apply-url.ts (type-only imports are fine).
      // (`isolatedEntries` would enforce this but crashes electron-vite 5 when stdout is not a TTY.)
      rollupOptions: {
        input: {
          // The app window's bridge (window.huntgry).
          index: resolve('src/preload/index.ts'),
          // In-app browser tabs: the auto-apply form filler (#24), nothing exposed to the page.
          'browser-page': resolve('src/preload/browser-page.ts')
        }
      }
    }
  },
  renderer: {
    resolve: { alias: { '@shared': resolve('src/shared') } },
    plugins: [react()]
  }
})
