import type { ReactNode } from 'react'
import { Anchor, MultiSelect, NumberInput, Select } from '@mantine/core'
import {
  activeFilterCount,
  DEFAULT_FILTERS,
  POSTED_WITHIN_DAYS,
  SENIORITY_LEVELS,
  WORKPLACE_FILTERS,
  type JobFilters,
  type PostedWithinDays,
  type SeniorityLevel,
  type SponsorshipFilter,
  type WorkplaceFilter
} from '@shared/job-filters'
import classes from './jobs.module.css'

/** The selects carry no visible label (Figma), so each option says what it filters. */
const SPONSORSHIP_OPTIONS: { value: SponsorshipFilter; label: string }[] = [
  { value: 'any', label: 'Visa: any' },
  { value: 'hide-no', label: 'Visa: hide “no sponsorship”' },
  { value: 'only-yes', label: 'Visa: only sponsors' }
]

const POSTED_LABEL: Record<PostedWithinDays, string> = {
  0: 'Posted any time',
  1: 'Past 24 hours',
  3: 'Past 3 days',
  7: 'Past week',
  14: 'Past 2 weeks',
  30: 'Past month'
}

interface Props {
  filters: JobFilters
  onChange(f: JobFilters): void
  /** Shows the filter fields (the "Filters" button in the toolbar folds them away). */
  open?: boolean
  /** The line under the fields: "Select all shown" and the count. */
  footer?: ReactNode
}

/** Filters of the saved-job list; saved per workspace by the page (Figma Jobs — Relevant, filter box). */
export function JobFiltersBar({ filters, onChange, open = true, footer }: Props) {
  const set = <K extends keyof JobFilters>(k: K, v: JobFilters[K]) => onChange({ ...filters, [k]: v })
  return (
    <div className={classes.filters}>
      {/* Folded, the fields stay mounted (the Filters button's aria-controls points here), only hidden. */}
      <div className={classes.filtersFields} id="jobs-filters" hidden={!open}>
        <Select
          w={220}
          aria-label="Visa sponsorship"
          data={SPONSORSHIP_OPTIONS}
          value={filters.sponsorship}
          allowDeselect={false}
          onChange={(v) => set('sponsorship', (v as SponsorshipFilter) ?? 'any')}
        />
        <MultiSelect
          w={200}
          aria-label="Workplace"
          placeholder={filters.workplace.length ? undefined : 'Any workplace'}
          data={[...WORKPLACE_FILTERS]}
          value={filters.workplace}
          onChange={(v) => set('workplace', v as WorkplaceFilter[])}
        />
        <MultiSelect
          w={220}
          aria-label="Seniority"
          placeholder={filters.seniority.length ? undefined : 'Any seniority'}
          data={[...SENIORITY_LEVELS]}
          value={filters.seniority}
          onChange={(v) => set('seniority', v as SeniorityLevel[])}
        />
        <Select
          w={160}
          aria-label="Posted"
          data={POSTED_WITHIN_DAYS.map((d) => ({ value: String(d), label: POSTED_LABEL[d] }))}
          value={String(filters.postedWithinDays)}
          allowDeselect={false}
          onChange={(v) => set('postedWithinDays', Number(v ?? 0) as PostedWithinDays)}
        />
        <NumberInput
          w={150}
          aria-label="Min. salary / year"
          placeholder="Min. salary / year"
          min={0}
          step={10000}
          thousandSeparator=","
          prefix="$ "
          hideControls
          value={filters.minSalary ?? ''}
          onChange={(v) => set('minSalary', typeof v === 'number' && v > 0 ? v : null)}
        />
        {activeFilterCount(filters) > 0 && (
          <Anchor className={classes.clearFilters} component="button" type="button" onClick={() => onChange(DEFAULT_FILTERS)}>
            Clear filters
          </Anchor>
        )}
      </div>
      {footer}
    </div>
  )
}
