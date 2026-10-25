import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { MAX_UNTRACEABLE_ITEMS, numbersIn, profileHasFact, profileStates, untraceableClaims } from './honesty'

const FIXTURE_PROFILE = join(__dirname, 'fixtures/master-profile.md')
const RESUME = join(__dirname, '../../shared/fixtures/tailored-resume_data.json')

let profile: string
let resume: Record<string, unknown>

beforeAll(async () => {
  profile = await readFile(FIXTURE_PROFILE, 'utf8')
  resume = JSON.parse(await readFile(RESUME, 'utf8'))
})

const clone = () => JSON.parse(JSON.stringify(resume)) as {
  summary: string
  experience: { company: string; title: string; bullets: string[] }[]
  education: { institution: string; degree: string }[]
  certifications?: { name: string }[]
}

describe('numbersIn', () => {
  it('reads 4M, 4 million and 4,000,000 as the same number, and 40% as 40', () => {
    expect(numbersIn('handles 4M requests').map((n) => n.value)).toEqual(['4000000'])
    expect(numbersIn('4 million requests, 4,000,000 in all').map((n) => n.value)).toEqual(['4000000', '4000000'])
    expect(numbersIn('cut cost by 40% to $1.2M').map((n) => n.value)).toEqual(['40', '1200000'])
    expect(numbersIn('a 3x speed-up, 12k users').map((n) => n.value)).toEqual(['3', '12000'])
  })

  it('leaves out years and digits inside names', () => {
    expect(numbersIn('Since 2019, on EC2 and S3 with OAuth2')).toEqual([])
    expect(numbersIn('from 40 s to 3 s').map((n) => n.value)).toEqual(['40', '3'])
  })
})

describe('profileStates / profileHasFact', () => {
  it('matches names word for word, whatever the case and punctuation', () => {
    expect(profileStates(profile, 'acme logistics')).toBe(true)
    expect(profileStates(profile, 'B.S. in Computer Science')).toBe(true)
    expect(profileStates(profile, 'BS in Computer Science')).toBe(false)
    expect(profileStates(profile, 'Globex')).toBe(false)
  })

  it('takes a source fact quoted from one profile line, not words gathered from the whole profile', () => {
    expect(profileHasFact(profile, 'Built order-routing services in Python and Go.')).toBe(true)
    // Nearly all words of one bullet, another ending.
    expect(profileHasFact(profile, 'Moved the shipment ledger to PostgreSQL, cutting report time from 40 s to 3 seconds')).toBe(true)
    expect(profileHasFact(profile, 'Built an event pipeline on RabbitMQ')).toBe(false)
    // Every word is somewhere in the profile, but on no one line.
    expect(profileHasFact(profile, 'Shipped Terraform services in Austin')).toBe(false)
  })
})

describe('untraceableClaims', () => {
  it('counts nothing for an honest resume of the profile', () => {
    expect(untraceableClaims({ profile, unbacked: [], reframings: [{ sourceFact: 'Built order-routing services in Python and Go.' }], resumeData: resume })).toEqual({
      count: 0,
      byKind: { unbacked: 0, reframing: 0, number: 0, identity: 0 },
      items: []
    })
  })

  it('counts requirements the resume shows without evidence (resumeCoverage().unbacked)', () => {
    const r = untraceableClaims({ profile, unbacked: ['Kafka', 'Rust'], reframings: [], resumeData: resume })
    expect(r.byKind.unbacked).toBe(2)
    expect(r.items).toEqual([
      { kind: 'unbacked', text: 'Kafka' },
      { kind: 'unbacked', text: 'Rust' }
    ])
  })

  it('counts a reframing whose source fact the profile does not state', () => {
    const r = untraceableClaims({
      profile,
      unbacked: [],
      reframings: [{ sourceFact: 'Built order-routing services in Python and Go.' }, { sourceFact: 'Built an event pipeline on RabbitMQ' }],
      resumeData: null
    })
    expect(r).toMatchObject({ count: 1, byKind: { reframing: 1 }, items: [{ kind: 'reframing', text: 'Built an event pipeline on RabbitMQ' }] })
  })

  it('counts a number the profile never states, once, and not one it states another way', () => {
    const data = clone()
    data.summary = 'Backend engineer serving 4 million requests a day, 12 years in.'
    data.experience[0].bullets.push('Cut cloud spend by 35%.', 'Saved 35% again.')
    const r = untraceableClaims({ profile, unbacked: [], reframings: [], resumeData: data })
    expect(r.byKind.number).toBe(2)
    expect(r.items.map((i) => i.text)).toEqual([expect.stringMatching(/^12 /), expect.stringMatching(/^35%/)])
  })

  it('counts an employer, title, school, degree or certification the profile does not name', () => {
    const data = clone()
    data.experience[0].company = 'Globex'
    data.experience[0].title = 'Staff Software Engineer'
    data.education[0].institution = 'MIT'
    data.education[0].degree = 'M.S. in Computer Science'
    data.certifications = [{ name: 'AWS Certified Solutions Architect' }]
    const r = untraceableClaims({ profile, unbacked: [], reframings: [], resumeData: data })
    expect(r.byKind.identity).toBe(5)
    expect(r.items.map((i) => i.text)).toEqual(['Globex', 'Staff Software Engineer', 'MIT', 'M.S. in Computer Science', 'AWS Certified Solutions Architect'])
  })

  it(`counts every claim but keeps only the first ${MAX_UNTRACEABLE_ITEMS}`, () => {
    const unbacked = Array.from({ length: 30 }, (_, i) => `Skill ${i}`)
    const r = untraceableClaims({ profile, unbacked, reframings: [], resumeData: { summary: 7 } })
    expect(r.count).toBe(30)
    expect(r.items).toHaveLength(MAX_UNTRACEABLE_ITEMS)
  })
})
