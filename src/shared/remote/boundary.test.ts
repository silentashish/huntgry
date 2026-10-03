import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `@huntgry/remote-protocol` is consumed by electron-vite, Metro and wrangler, so it must be
 * self-contained (ADR-0001, "Package boundary"): every source file imports only files in this
 * folder and `tweetnacl`, uses no Node, DOM or Electron API, and the package declares no other
 * dependency. In the spirit of #24's guard.test.ts: this fails the build, it does not warn.
 */

const DIR = __dirname
const ROOT = resolve(DIR, '../../..')

const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.d.ts'))
  .map((f) => join(DIR, f))

const imports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^(?:import|export)\b[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('import boundary', () => {
  it('covers the package', () => {
    const names = sources.map((f) => f.slice(DIR.length + 1)).sort()
    expect(names).toEqual(['check.ts', 'crypto.ts', 'dto.ts', 'guards.ts', 'index.ts', 'limits.ts', 'protocol.ts', 'text.ts'])
  })

  for (const file of sources) {
    it(`${file.slice(ROOT.length + 1)} imports only this folder and tweetnacl`, () => {
      const specs = imports(file)
      for (const spec of specs) expect(spec, `${spec} in ${file}`).toMatch(/^(\.\/[a-z-]+|tweetnacl)$/)
      // No dynamic imports or requires either.
      const source = readFileSync(file, 'utf8')
      expect(source).not.toMatch(/\brequire\s*\(/)
      expect(source).not.toMatch(/\bimport\s*\(/)
    })

    it(`${file.slice(ROOT.length + 1)} uses no Node, DOM or Electron API`, () => {
      const source = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      for (const pattern of [/\bBuffer\b/, /\bprocess\./, /\bnode:/, /\bwindow\./, /\bdocument\./, /\bglobalThis\./, /\belectron\b/, /\bcrypto\.(subtle|randomUUID|getRandomValues)/, /\bfetch\s*\(/, /\bWebSocket\b/]) {
        expect(source, `${pattern} in ${file}`).not.toMatch(pattern)
      }
    })
  }

  it('package.json depends on tweetnacl only and exposes the TypeScript sources', () => {
    const pkg = JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8'))
    expect(pkg.name).toBe('@huntgry/remote-protocol')
    expect(Object.keys(pkg.dependencies)).toEqual(['tweetnacl'])
    expect(pkg.devDependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
    expect(pkg.exports['.']).toBe('./index.ts')
  })

  it('type-checks without node or dom libs (what a Worker and Hermes see)', () => {
    const tsconfig = readFileSync(join(DIR, 'tsconfig.json'), 'utf8').replace(/\/\/.*$/gm, '')
    const config = JSON.parse(tsconfig)
    expect(config.compilerOptions.types).toEqual([])
    expect(config.compilerOptions.lib.map((l: string) => l.toLowerCase())).not.toContain('dom')
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(root.scripts.typecheck).toContain('typecheck:remote')
  })

  it('is declared as a workspace for npm and pnpm, together with relay/ and mobile/', () => {
    const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    expect(root.workspaces).toEqual(['src/shared/remote', 'relay', 'mobile'])
    const pnpm = readFileSync(join(ROOT, 'pnpm-workspace.yaml'), 'utf8')
    const packageSection = pnpm.match(/^packages:\n((?:  - [^\n]+\n)*)/m)?.[1] ?? ''
    const packages = [...packageSection.matchAll(/^  - (\S+)$/gm)].map((m) => m[1])
    expect(packages).toEqual(root.workspaces)
    expect(root.dependencies.tweetnacl).toBe(JSON.parse(readFileSync(join(DIR, 'package.json'), 'utf8')).dependencies.tweetnacl)
  })
})
