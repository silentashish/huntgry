import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { MantineProvider } from '@mantine/core'
import { describe, expect, it } from 'vitest'
import { AboutCard, releaseUrl } from './AboutCard'

/** Settings → About (#167): the version the release was cut from, never a hard-coded one. */

const pkgVersion = (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }).version

const render = (version: string) =>
  renderToStaticMarkup(
    <MantineProvider>
      <AboutCard version={version} />
    </MantineProvider>
  )

describe('About card', () => {
  it("shows the version it is given and links to that version's release", () => {
    const html = render(pkgVersion)
    expect(html).toContain(`>${pkgVersion}</`)
    expect(html).toContain(`href="https://github.com/silentashish/huntgry/releases/tag/v${pkgVersion}"`)
  })

  it('links to every release when the version is unknown', () => {
    expect(render('')).toContain('version unknown')
    expect(releaseUrl('')).toBe('https://github.com/silentashish/huntgry/releases')
  })

  it('reads the version from package.json at build time, the same value app.getVersion() reports', () => {
    const config = readFileSync(resolve('electron.vite.config.ts'), 'utf8')
    expect(config).toMatch(/define: \{ __APP_VERSION__: JSON\.stringify\(version\) \}/)
    expect(readFileSync(resolve('src/renderer/src/pages/settings/AboutCard.tsx'), 'utf8')).not.toMatch(/\d+\.\d+\.\d+/)
  })
})
