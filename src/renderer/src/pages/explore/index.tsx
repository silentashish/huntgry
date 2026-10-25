import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Loader, NumberInput, SegmentedControl, Select, TextInput } from '@mantine/core'
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconCompass,
  IconLink,
  IconPlus,
  IconRefresh,
  IconSearch
} from '@tabler/icons-react'
import { WORK_MODELS, type ExploreJob, type ExploreList, type JobrightAccount } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { CompanyAvatar, EmptyState, MonoLabel, PageHeader, StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import {
  addedJobs,
  CATEGORY_STORAGE_KEY,
  categoryLabel,
  categoryOptions,
  dayGroups,
  dayLabel,
  defaultDay,
  EARLIER_STORAGE_KEY,
  effectiveFilters,
  NO_FILTERS,
  readCategory,
  readFlag,
  shortSalary,
  sourceLabel,
  splitDays,
  updatedAgo,
  visibleRows,
  writePref,
  type DayGroup,
  type ExploreFilters,
  type H1bFilter,
  type WorkModelFilter
} from './view'
import classes from './explore.module.css'

const WORK_TONE = { Remote: 'trail', Hybrid: 'neutral', 'On Site': 'neutral' } as const
const H1B_TONE = { Yes: 'success', No: 'neutral', 'Not Sure': 'neutral' } as const

const CATEGORY_OPTIONS = categoryOptions()

/**
 * Explore (#142, #169): Jobright's jobs of one category from the newgrad-jobs API (the GitHub README when the API
 * fails), grouped by posted day (today first, days past the newest seven folded), cached in the workspace. Any row
 * can be added to the Jobs page in one click.
 */
export function ExplorePage() {
  const { navigate } = useNavigation()
  const [category, setCategory] = useState(readCategory)
  const [list, setList] = useState<ExploreList | null>(null)
  const [saved, setSaved] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickedDay, setDay] = useState<string | null>(null)
  const [filters, setFilters] = useState<ExploreFilters>(NO_FILTERS)
  const [earlierOpen, setEarlierOpen] = useState(() => readFlag(EARLIER_STORAGE_KEY))
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  const [account, setAccount] = useState<JobrightAccount | null>(null)
  // The newest request wins: a slow answer for a category left meanwhile is dropped.
  const request = useRef(0)

  useEffect(() => {
    api.jobs.list().then(setSaved, () => undefined)
    api.explore.account().then(setAccount, () => undefined)
    // "Updated … ago" stays true while the page is open.
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  // The category's cached list; main fetches it only when the workspace has no copy yet.
  useEffect(() => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    api.explore
      .list(category)
      .then(
        (l) => id === request.current && setList(l),
        (err) => {
          if (id !== request.current) return
          setList(null)
          setError(errorText(err))
        }
      )
      .finally(() => id === request.current && setLoading(false))
  }, [category])

  function pickCategory(c: string | null) {
    if (!c || c === category) return
    writePref(CATEGORY_STORAGE_KEY, c)
    setDay(null)
    setCategory(c)
  }

  async function refresh() {
    const id = ++request.current
    setRefreshing(true)
    setError(null)
    try {
      const l = await api.explore.refresh(category)
      if (id !== request.current) return
      setList(l)
      setNow(Date.now())
    } catch (err) {
      // The cached list stays on screen; the error says why it could not be refreshed.
      if (id === request.current) setError(errorText(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function add(row: ExploreJob) {
    setAdding((s) => new Set(s).add(row.id))
    setError(null)
    try {
      const job = await api.explore.add(row.id, category)
      setSaved((cur) => [...cur.filter((j) => j.id !== job.id), job])
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding((s) => {
        const next = new Set(s)
        next.delete(row.id)
        return next
      })
    }
  }

  function toggleEarlier() {
    writePref(EARLIER_STORAGE_KEY, earlierOpen ? '0' : '1')
    setEarlierOpen(!earlierOpen)
  }

  const set = <K extends keyof ExploreFilters>(key: K, value: ExploreFilters[K]) => setFilters((f) => ({ ...f, [key]: value }))

  const shownList = list?.category === category ? list : null
  const jobs = shownList?.jobs ?? []
  const readme = shownList?.source === 'readme'
  const groups = useMemo(() => dayGroups(jobs), [jobs])
  const { recent, older } = useMemo(() => splitDays(groups), [groups])
  const day = pickedDay && groups.some((g) => g.day === pickedDay) ? pickedDay : defaultDay(groups, new Date(now))
  const applied = effectiveFilters(filters, shownList?.source)
  const rows = useMemo(() => visibleRows(jobs, { day, ...applied }), [jobs, day, applied.text, applied.workModel, applied.h1b, applied.minSalary])
  const added = useMemo(() => addedJobs(saved), [saved])
  const nowDate = new Date(now)
  // A picked older day stays in view while "Earlier" is folded.
  const showOlder = earlierOpen || older.some((g) => g.day === day)
  const olderJobs = older.reduce((n, g) => n + g.count, 0)

  const dayButton = (g: DayGroup) => (
    <button key={g.day} type="button" className={classes.day} aria-pressed={g.day === day} onClick={() => setDay(g.day)}>
      <span>{dayLabel(g.day, nowDate)}</span>
      <span className={classes.dayCount}>{g.count}</span>
    </button>
  )

  return (
    <div className={classes.page}>
      <PageHeader
        eyebrow={`Jobright · ${categoryLabel(category)} · ${jobs.length.toLocaleString('en-US')} jobs`}
        title="Explore"
        subtitle="New-grad and internship jobs from Jobright's newgrad-jobs list. Add any of them to Jobs."
        actions={
          <>
            <MonoLabel size="sm" tone="muted">
              {shownList ? updatedAgo(shownList.fetchedAt, now) : ''}
            </MonoLabel>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        }
      />

      <div className={classes.row}>
        <Select
          className={classes.category}
          aria-label="Category"
          data={CATEGORY_OPTIONS}
          value={category}
          onChange={pickCategory}
          allowDeselect={false}
          searchable
          comboboxProps={{ withinPortal: true }}
        />
        {shownList && (
          <MonoLabel size="sm" tone="secondary" component="p" className={classes.source}>
            <span aria-label="List source">{sourceLabel(shownList)}</span>
          </MonoLabel>
        )}
      </div>

      {readme && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Showing Jobright's GitHub list instead"
          className={classes.connect}
        >
          {shownList?.fallbackReason ?? 'The newgrad-jobs API could not be used.'} This list has only the last few days of
          new-grad software jobs, without salary or H1B details. Refresh to try the API again.
        </Alert>
      )}

      {account && account.connected !== true && (
        <Alert
          color="info"
          variant="light"
          icon={<IconLink size={18} />}
          title="Get the employer's own posting links"
          className={classes.connect}
        >
          <div className={classes.connectBody}>
            <span>
              Jobs from this list link Jobright's page. Connect your Jobright account once and jobs you add link the
              employer's posting instead.
            </span>
            <Button size="xs" variant="default" onClick={() => navigate('settings', { section: 'jobright' })}>
              Connect Jobright
            </Button>
          </div>
        </Alert>
      )}

      {error && (
        <Alert color="danger" variant="light" title="The Jobright list could not be loaded" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Loader aria-label="Loading the Jobright list" />
      ) : jobs.length === 0 ? (
        <EmptyState
          className={classes.empty}
          compact
          icon={<IconCompass size={22} />}
          title="No jobs to explore yet"
          description="Huntgry reads Jobright's newgrad-jobs list. Refresh to try again."
          actions={
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          <div className={classes.days} role="group" aria-label="Posted day">
            {recent.map(dayButton)}
            {older.length > 0 && (
              <button
                type="button"
                className={classes.earlier}
                aria-expanded={showOlder}
                aria-label={`Earlier, ${older.length} days, ${olderJobs} jobs`}
                onClick={toggleEarlier}
              >
                <IconChevronRight size={14} className={classes.earlierChevron} aria-hidden />
                <span>Earlier</span>
                <span className={classes.dayCount}>{olderJobs}</span>
              </button>
            )}
            {showOlder && older.map(dayButton)}
          </div>
          <div className={classes.row}>
            <TextInput
              className={classes.grow}
              leftSection={<IconSearch size={16} />}
              placeholder="Filter by company, title, location or industry"
              aria-label="Filter Jobright jobs"
              value={filters.text}
              onChange={(e) => set('text', e.currentTarget.value)}
            />
            <SegmentedControl
              aria-label="Work model"
              value={filters.workModel}
              onChange={(v) => set('workModel', v as WorkModelFilter)}
              data={[{ value: 'all', label: 'Any' }, ...WORK_MODELS.map((w) => ({ value: w, label: w }))]}
            />
            <Select
              w={170}
              aria-label="H1B sponsorship"
              title={readme ? 'The GitHub list has no H1B details' : undefined}
              disabled={readme}
              data={[
                { value: 'all', label: 'Any H1B' },
                { value: 'yes', label: 'Sponsors H1B' },
                { value: 'not-no', label: 'H1B not ruled out' }
              ]}
              value={filters.h1b}
              onChange={(v) => set('h1b', (v ?? 'all') as H1bFilter)}
              allowDeselect={false}
            />
            <NumberInput
              w={170}
              aria-label="Min. salary / year"
              placeholder="Min. salary / year"
              title={readme ? 'The GitHub list has no salaries' : undefined}
              disabled={readme}
              min={0}
              step={10000}
              thousandSeparator=","
              prefix="$ "
              hideControls
              value={filters.minSalary ?? ''}
              onChange={(v) => set('minSalary', typeof v === 'number' && v > 0 ? v : null)}
            />
          </div>
          <MonoLabel component="div">
            {rows.length} of {groups.find((g) => g.day === day)?.count ?? 0} jobs · {day ? dayLabel(day, nowDate) : ''}
          </MonoLabel>
          {rows.length === 0 ? (
            <p className={classes.note}>No job of this day matches the filters.</p>
          ) : (
            <ul className={classes.list} aria-label="Jobright jobs">
              {rows.map((r) => {
                const savedJob = added.get(r.id)
                return (
                  <li key={r.id} className={classes.job} aria-label={`${r.title} at ${r.company}`}>
                    <CompanyAvatar name={r.company} />
                    <div className={classes.body}>
                      <button
                        type="button"
                        className={classes.title}
                        title="Open the posting in the browser"
                        onClick={() => navigate('browser', { url: r.url })}
                      >
                        {r.title}
                      </button>
                      <p className={classes.meta}>{[r.company, r.location].filter(Boolean).join(' · ')}</p>
                      {(r.salary || r.industry || r.companySize) && (
                        <p className={classes.meta}>
                          {[r.salary && shortSalary(r.salary), r.industry?.join(', '), r.companySize && `${r.companySize} people`]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      )}
                    </div>
                    <div className={classes.side}>
                      {r.h1b && (
                        <StatusPill tone={H1B_TONE[r.h1b]} title="H1B sponsorship, as Jobright reports it">
                          H1B: {r.h1b}
                        </StatusPill>
                      )}
                      {r.workModel && <StatusPill tone={WORK_TONE[r.workModel]}>{r.workModel}</StatusPill>}
                      {savedJob ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconCheck size={14} />}
                          title="Open it on the Jobs page"
                          onClick={() => navigate('jobs', { reload: Date.now(), openId: savedJob.id })}
                        >
                          Added
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          leftSection={<IconPlus size={14} />}
                          loading={adding.has(r.id)}
                          onClick={() => void add(r)}
                        >
                          Add to Jobs
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
