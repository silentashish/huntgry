import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Phone and relay code stays out of the desktop bundle (ADR-0001, "Repository layout"):
 * `relay/` and `mobile/` list their own dependencies, the root gets only `tweetnacl`.
 */
const ROOT = resolve(__dirname, '../../..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

describe('root dependencies', () => {
  it('contain no expo*, react-native* or wrangler entries', () => {
    for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
      for (const name of Object.keys(pkg[section] ?? {})) {
        expect(name, section).not.toMatch(/^(expo|react-native|wrangler|@expo\/|@react-native|@cloudflare\/)/)
      }
    }
  })

  it('include tweetnacl for main, and no workspace package', () => {
    expect(pkg.dependencies.tweetnacl).toBeDefined()
    for (const name of Object.keys(pkg.dependencies)) expect(name).not.toMatch(/^@huntgry\//)
  })

  it('packages only out/**, the icon and package.json (electron-builder.yml)', () => {
    const yml = readFileSync(join(ROOT, 'electron-builder.yml'), 'utf8')
    const files = [...yml.matchAll(/^\s+-\s+(\S+)/gm)].map((m) => m[1])
    expect(files).toEqual(['out/**', 'resources/icon.png', 'package.json'])
  })
})
