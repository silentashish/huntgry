import { readdirSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { APPLY_ATS } from '../../apply-types'
import { scanPage } from '../engine'
import { ADAPTERS, adapterFor, generic } from './index'

describe('adapter registry', () => {
  it('lists every adapter file once, generic last', () => {
    const files = readdirSync(__dirname).filter((f) => f.endsWith('.ts') && !/^(index|types|text)\.ts$/.test(f) && !f.endsWith('.test.ts'))
    expect(ADAPTERS.map((a) => `${a.ats}.ts`).sort()).toEqual(files.sort())
    expect(ADAPTERS.at(-1)).toBe(generic)
    expect(new Set(ADAPTERS.map((a) => a.ats)).size).toBe(ADAPTERS.length)
    for (const a of ADAPTERS) expect(APPLY_ATS).toContain(a.ats)
  })

  it('falls back to generic for an ATS host without an adapter yet', () => {
    const dom = new JSDOM('<form><input type="file" name="resume"></form>', {
      url: 'https://jobs.ashbyhq.com/acme/1/application'
    })
    const adapter = adapterFor(new URL(dom.window.location.href), dom.window.document)
    // Until #64 adds adapters/ashby.ts, Ashby pages get the generic rules.
    expect(adapter.ats).toBe(ADAPTERS.find((a) => a.ats === 'ashby')?.ats ?? 'generic')
  })

  it('reports the default step when an adapter has no step hook', () => {
    const dom = new JSDOM('<form><input name="email" autocomplete="email"><input type="file" name="resume"></form>', {
      url: 'https://careers.example.com/apply'
    })
    expect(scanPage(dom.window.document)).toMatchObject({ ats: 'generic', step: 'form', stepTitle: null })
  })
})
