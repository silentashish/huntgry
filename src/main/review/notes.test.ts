import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { isNotesV2, normalizeText, parseReviewNotes, parseTailoringNotes, reframingId } from './notes'

const SAMPLE = `# Review notes
<!-- huntgry-review v1 · run 20260930-120000-abcdef · unattended -->

## Used standing approvals
- Source fact: Migrated the PHP monolith to Node services at Houzz
  Wording: Led a PHP-to-Node migration of the core services

## Proposed reframings (not used)
### R1 · High-throughput services
- Source fact: Handled 2k requests per second on the search API
- Proposed wording: Built high-throughput services (2k rps) on the search API
- Why unsure: "high-throughput" may overstate the scale

### R2 · Team leadership
- Source fact: Mentored two juniors
- Proposed wording: Led a team of two engineers
- Why unsure: mentoring is not leading

## Open gaps
- Kubernetes: nothing honest to say
- Go: nothing honest to say

## Notes
Date style right-aligned. Cover letter angles on the migration.
`

describe('parseReviewNotes', () => {
  it('reads every section of the documented format and derives stable ids', () => {
    const n = parseReviewNotes(SAMPLE)
    expect(n.runId).toBe('20260930-120000-abcdef')
    expect(n.usedApprovals).toEqual([
      {
        sourceFact: 'Migrated the PHP monolith to Node services at Houzz',
        wording: 'Led a PHP-to-Node migration of the core services'
      }
    ])
    expect(n.proposed).toHaveLength(2)
    expect(n.proposed[0]).toMatchObject({
      requirement: 'High-throughput services',
      sourceFact: 'Handled 2k requests per second on the search API',
      wording: 'Built high-throughput services (2k rps) on the search API',
      reason: '"high-throughput" may overstate the scale'
    })
    expect(n.proposed[1].requirement).toBe('Team leadership')
    expect(n.openGaps).toEqual(['Kubernetes: nothing honest to say', 'Go: nothing honest to say'])
    expect(n.notes).toBe('Date style right-aligned. Cover letter angles on the migration.')
    expect(n.parseWarning).toBeUndefined()
    const expected = createHash('sha256')
      .update('Handled 2k requests per second on the search API\nBuilt high-throughput services (2k rps) on the search API')
      .digest('hex')
    expect(n.proposed[0].id).toBe(expected)
  })

  it('ids ignore surrounding and inner whitespace, so desktop and phone agree', () => {
    expect(reframingId('  a   b ', 'c\n d')).toBe(reframingId('a b', 'c d'))
    expect(normalizeText(' x\t\ty ')).toBe('x y')
    expect(reframingId('a', 'b')).not.toBe(reframingId('a', 'c'))
  })

  it('tolerates heading case and order, star bullets, missing sections and no sub-headings', () => {
    const n = parseReviewNotes(`## OPEN GAPS
* Rust: nothing honest to say

## proposed reframings
* Source fact: fact one
* Wording: wording one
* Reason: not sure
* Source fact: fact two
* Proposed wording: wording two
`)
    expect(n.openGaps).toEqual(['Rust: nothing honest to say'])
    expect(n.proposed.map((p) => [p.sourceFact, p.wording, p.reason])).toEqual([
      ['fact one', 'wording one', 'not sure'],
      ['fact two', 'wording two', undefined]
    ])
    expect(n.usedApprovals).toEqual([])
    expect(n.notes).toBe('')
    expect(n.parseWarning).toBeUndefined()
  })

  it('joins wrapped lines into the previous field', () => {
    const n = parseReviewNotes(`## Proposed reframings
- Source fact: a long fact that
  continues here
- Proposed wording: short
`)
    expect(n.proposed[0].sourceFact).toBe('a long fact that continues here')
  })

  it('warns on a file without the format and yields no reframings', () => {
    const n = parseReviewNotes('Just some prose the agent wrote.\n- not a section')
    expect(n.proposed).toEqual([])
    expect(n.parseWarning).toMatch(/format/)
    expect(parseReviewNotes('').parseWarning).toMatch(/format/)
  })

  it('warns when the proposed section has content that does not parse', () => {
    const n = parseReviewNotes('## Proposed reframings\nI would reframe the Houzz work as leadership.\n')
    expect(n.proposed).toEqual([])
    expect(n.parseWarning).toMatch(/could not be read/)
    expect(parseReviewNotes('## Proposed reframings\nNone.\n').parseWarning).toBeUndefined()
  })
})


const SAMPLE_V2 = `# Tailoring notes
<!-- resume-tailor notes v2 -->

## Direct hits
- TypeScript: five years of TypeScript at Houzz
- React: built the search UI in React

## Reframings used
### High-throughput services
- Source fact: Handled 2k requests per second on the search API
- Wording: Built high-throughput services (2k rps) on the search API

### Team leadership
- Source fact: Mentored two juniors
- Wording: Mentored two engineers through their first launches,
  pairing daily

## Gaps left open
- Kubernetes: no container orchestration in the profile
- Go: never used

## Decisions
- Right-aligned dates: a startup, a human reads it first.
- Cut the 2014 internship to keep one page.
`

describe('parseTailoringNotes (v2)', () => {
  it('reads every section of the v2 format', () => {
    expect(isNotesV2(SAMPLE_V2)).toBe(true)
    const n = parseTailoringNotes(SAMPLE_V2)
    expect(n.format).toBe('v2')
    expect(n.directHits).toEqual(['TypeScript: five years of TypeScript at Houzz', 'React: built the search UI in React'])
    expect(n.reframingsUsed.map((r) => [r.requirement, r.sourceFact, r.wording])).toEqual([
      ['High-throughput services', 'Handled 2k requests per second on the search API', 'Built high-throughput services (2k rps) on the search API'],
      ['Team leadership', 'Mentored two juniors', 'Mentored two engineers through their first launches, pairing daily']
    ])
    expect(n.openGaps).toEqual(['Kubernetes: no container orchestration in the profile', 'Go: never used'])
    expect(n.decisions).toEqual(['Right-aligned dates: a startup, a human reads it first.', 'Cut the 2014 internship to keep one page.'])
    expect(n.proposed).toEqual([])
    expect(n.usedApprovals).toEqual([])
    expect(n.parseWarning).toBeUndefined()
  })

  it('gives a used reframing the same id a v1 reframing with the same fact and wording has', () => {
    const v2 = parseTailoringNotes(SAMPLE_V2).reframingsUsed[0]
    const v1 = parseReviewNotes(SAMPLE).proposed[0]
    expect(v2.id).toBe(v1.id)
    expect(v2.id).toBe(reframingId('Handled 2k requests per second on the search API', 'Built high-throughput services (2k rps) on the search API'))
  })

  it('reads "None." sections as empty, without a warning', () => {
    const n = parseTailoringNotes(`# Tailoring notes
<!-- resume-tailor notes v2 -->

## Direct hits
- Python: the whole profile

## Reframings used
None.

## Gaps left open
None.

## Decisions
- None.
`)
    expect(n.directHits).toEqual(['Python: the whole profile'])
    expect(n.reframingsUsed).toEqual([])
    expect(n.openGaps).toEqual([])
    expect(n.decisions).toEqual([])
    expect(n.parseWarning).toBeUndefined()
  })

  it('does not read free-form notes without the marker (an older attended run, or a run that ignored the format)', () => {
    const freeForm = '# Tailoring notes\n\n## Reframings used\n### Leadership\n- Source fact: a\n- Wording: b\n'
    expect(isNotesV2(freeForm)).toBe(false)
    const n = parseTailoringNotes(freeForm)
    expect(n.reframingsUsed).toEqual([])
    expect(n.parseWarning).toMatch(/not in the v2 format/)
  })

  it('warns when the reframings used have content that does not parse', () => {
    const n = parseTailoringNotes('<!-- resume-tailor notes v2 -->\n## Reframings used\nI framed mentoring as leadership.\n')
    expect(n.reframingsUsed).toEqual([])
    expect(n.parseWarning).toMatch(/could not be read/)
    expect(parseTailoringNotes('<!-- resume-tailor notes v2 -->\nno sections').parseWarning).toMatch(/none of the v2 sections/)
  })

  it('leaves the v1 parser as it was: format v1, no v2 fields', () => {
    const n = parseReviewNotes(SAMPLE)
    expect(n.format).toBe('v1')
    expect(n.directHits).toEqual([])
    expect(n.reframingsUsed).toEqual([])
    expect(n.decisions).toEqual([])
  })
})
