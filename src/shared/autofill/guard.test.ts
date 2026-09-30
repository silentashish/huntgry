import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Huntgry never submits an application (owner decision, #24). This fails the
 * build if the code that runs inside job pages ever gains a way to: calling
 * submit()/requestSubmit(), clicking anything, or synthesising key/mouse input.
 */

const ROOT = resolve(__dirname, '../../..')
const FORBIDDEN = [
  /\.submit\s*\(/,
  /requestSubmit/,
  /\.click\s*\(/,
  /new\s+[\w.]*(Keyboard|Mouse|Pointer|Submit)Event\b/,
  /\bsendInputEvent\b/,
  /Input\.dispatch(Key|Mouse)Event/
]

function pageSources(): string[] {
  const dir = join(ROOT, 'src/shared/autofill')
  const own = readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .map((f) => join(dir, f))
  return [
    ...own,
    join(ROOT, 'src/shared/autofill-channels.ts'),
    join(ROOT, 'src/preload/browser-page.ts'),
    join(ROOT, 'src/main/apply/service.ts'),
    join(ROOT, 'src/main/apply/upload.ts')
  ]
}

describe('no-submit guard', () => {
  it('covers the engine, the page preload and the apply service', () => {
    expect(pageSources().length).toBeGreaterThanOrEqual(8)
  })

  for (const file of pageSources()) {
    it(`${file.slice(ROOT.length + 1)} cannot submit, click or type`, () => {
      const source = readFileSync(file, 'utf8')
      for (const pattern of FORBIDDEN) expect(source, `${pattern} in ${file}`).not.toMatch(pattern)
    })
  }
})

/** Runtime (non-type) module specifiers imported by a file. */
const runtimeImports = (file: string) =>
  [...readFileSync(file, 'utf8').matchAll(/^import (?!type )[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])

describe('preload bundles', () => {
  // Sandboxed preloads cannot load shared chunks, so the two preload entries must share no runtime module.
  it('keeps the page preload and the app preload apart', () => {
    for (const spec of runtimeImports(join(ROOT, 'src/preload/browser-page.ts'))) {
      expect(spec).toMatch(/^(electron|@shared\/autofill\/|@shared\/autofill-channels$)/)
    }
    const preloads = readdirSync(join(ROOT, 'src/preload')).filter((f) => f.endsWith('.ts') && f !== 'browser-page.ts')
    for (const f of preloads) {
      for (const spec of runtimeImports(join(ROOT, 'src/preload', f))) {
        expect(spec, f).not.toMatch(/autofill|apply-url|apply-values/)
      }
    }
  })
})
