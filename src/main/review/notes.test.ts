import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { normalizeText, parseReviewNotes, reframingId } from './notes'

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
