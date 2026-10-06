import { Anchor, Group, MultiSelect, NumberInput, Select, Switch } from '@mantine/core'
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

const SPONSORSHIP_OPTIONS: { value: SponsorshipFilter; label: string }[] = [
  { value: 'any', label: 'Any' },
  { value: 'hide-no', label: 'Hide "no sponsorship"' },
  { value: 'only-yes', label: 'Only sponsors' }
]

const POSTED_LABEL: Record<PostedWithinDays, string> = {
  0: 'Any time',
  1: 'Past 24 hours',
  3: 'Past 3 days',
  7: 'Past week',
  14: 'Past 2 weeks',
  30: 'Past month'
}

/** Filters of the saved-job list, plus the auto-refresh toggle; both are saved per workspace by the page. */
export function JobFiltersBar({
  filters,
  onChange,
  autoRefresh,
  onAutoRefresh
}: {
  filters: JobFilters
  onChange: (f: JobFilters) => void
  autoRefresh: boolean
  onAutoRefresh: (on: boolean) => void
}) {
  const set = <K extends keyof JobFilters>(k: K, v: JobFilters[K]) => onChange({ ...filters, [k]: v })
  return (
    <Group gap="sm" align="flex-end" wrap="wrap">
      <Select
        size="xs"
        w={180}
        label="Visa sponsorship"
        data={SPONSORSHIP_OPTIONS}
        value={filters.sponsorship}
        allowDeselect={false}
        onChange={(v) => set('sponsorship', (v as SponsorshipFilter) ?? 'any')}
      />
      <MultiSelect
        size="xs"
        w={190}
        label="Workplace"
        placeholder={filters.workplace.length ? undefined : 'Any'}
        data={[...WORKPLACE_FILTERS]}
        value={filters.workplace}
        onChange={(v) => set('workplace', v as WorkplaceFilter[])}
      />
      <MultiSelect
        size="xs"
        w={220}
        label="Seniority"
        placeholder={filters.seniority.length ? undefined : 'Any'}
        data={[...SENIORITY_LEVELS]}
        value={filters.seniority}
        onChange={(v) => set('seniority', v as SeniorityLevel[])}
      />
      <Select
        size="xs"
        w={140}
        label="Posted"
        data={POSTED_WITHIN_DAYS.map((d) => ({ value: String(d), label: POSTED_LABEL[d] }))}
        value={String(filters.postedWithinDays)}
        allowDeselect={false}
        onChange={(v) => set('postedWithinDays', Number(v ?? 0) as PostedWithinDays)}
      />
      <NumberInput
        size="xs"
        w={140}
        label="Min. salary / year"
        placeholder="Any"
        min={0}
        step={10000}
        thousandSeparator=","
        prefix="$"
        value={filters.minSalary ?? ''}
        onChange={(v) => set('minSalary', typeof v === 'number' && v > 0 ? v : null)}
      />
      {activeFilterCount(filters) > 0 && (
        <Anchor size="xs" component="button" type="button" mb={6} onClick={() => onChange(DEFAULT_FILTERS)}>
          Clear filters
        </Anchor>
      )}
      <Switch
        size="xs"
        ml="auto"
        mb={6}
        label="Auto-refresh relevant jobs"
        description="On open, when the last refresh is over 12 hours old"
        checked={autoRefresh}
        onChange={(e) => onAutoRefresh(e.currentTarget.checked)}
      />
    </Group>
  )
}
