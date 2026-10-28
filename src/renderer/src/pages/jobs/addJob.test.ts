import { describe, expect, it } from 'vitest'
import { addJobInput, MIN_CHARS } from './addJob'

describe('addJobInput (#189: one box for a link or a posting)', () => {
  it('reads a lone http(s) URL as a link, whitespace around it included', () => {
    expect(addJobInput('https://boards.greenhouse.io/acme/jobs/1')).toBe('link')
    expect(addJobInput('  HTTP://example.com/job?id=2 \n')).toBe('link')
  })

  it('reads anything longer than a URL as a posting, and short text as too short', () => {
    const posting = 'Backend Engineer at Acme. You will build payment APIs in Go and Postgres.'
    expect(posting.length).toBeGreaterThanOrEqual(MIN_CHARS)
    expect(addJobInput(posting)).toBe('text')
    expect(addJobInput(`https://acme.com/jobs/1\n${posting}`)).toBe('text')
    expect(addJobInput('Backend Engineer')).toBe('short')
    expect(addJobInput('acme.com/jobs/1')).toBe('short')
  })

  it('is empty for blank input', () => {
    expect(addJobInput('')).toBe('empty')
    expect(addJobInput('  \n ')).toBe('empty')
  })
})
