import { describe, expect, it } from 'vitest'
import type { ApplicationRecord, ApplicationStatus } from '@shared/applications-types'
import { countByStatus, DEFAULT_FILTER, filterApplications } from './filter'

const rec = (
  id: string,
  company: string,
  createdAt: string,
  status: ApplicationStatus,
  notes = ''
): ApplicationRecord => ({
  id,
  role: 'Engineer',
  company,
  jobId: id,
  jobTitle: `${company} role`,
  jobUrl: null,
  createdAt,
  updatedAt: createdAt,
  files: [],
  resumePages: [],
  coverPages: [],
  build: { status: 'pass', failed: [], warnings: 0, resumePages: 1 },
  tracking: { status, notes }
})

const apps = [
  rec('1', 'Acme', '2026-09-01T00:00:00Z', 'applied', 'recruiter Sam'),
  rec('2', 'Globex', '2026-09-03T00:00:00Z', 'generated'),
  rec('3', 'Initech', '2026-09-02T00:00:00Z', 'archived')
]

describe('dashboard filter', () => {
  it('hides archived by default and sorts newest first', () => {
    expect(filterApplications(apps, DEFAULT_FILTER).map((a) => a.id)).toEqual(['2', '1'])
  })
  it('filters by status, including archived when asked', () => {
    expect(filterApplications(apps, { ...DEFAULT_FILTER, statuses: ['archived'] }).map((a) => a.id)).toEqual(['3'])
  })
  it('searches company, title and notes', () => {
    expect(filterApplications(apps, { ...DEFAULT_FILTER, text: 'sam' }).map((a) => a.id)).toEqual(['1'])
    expect(filterApplications(apps, { ...DEFAULT_FILTER, text: 'GLOBEX' }).map((a) => a.id)).toEqual(['2'])
  })
  it('sorts by company or oldest', () => {
    expect(
      filterApplications(apps, {
        ...DEFAULT_FILTER,
        sort: 'company',
        statuses: ['applied', 'generated', 'archived']
      }).map((a) => a.company)
    ).toEqual(['Acme', 'Globex', 'Initech'])
    expect(filterApplications(apps, { ...DEFAULT_FILTER, sort: 'oldest' }).map((a) => a.id)).toEqual(['1', '2'])
  })
  it('counts per status', () => {
    expect(countByStatus(apps)).toMatchObject({ applied: 1, generated: 1, archived: 1, offer: 0 })
  })
})
