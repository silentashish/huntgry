import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { scoreRows, type RowScore } from '@shared/explore-score'
import { WORK_MODELS, type ExploreJob, type ExploreList, type JobrightAccount } from '@shared/explore-types'
import { profileSignals, type ProfileSignals } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../../api'
import { CompanyAvatar, EmptyState, MonoLabel, StatusPill } from '../../../components/ui'
import { useNavigation } from '../../../navigation'
import { MatchBadge } from '../MatchBadge'
import type { TabHeader } from '../tabs'
import {
  addedJobs,
  CATEGORY_STORAGE_KEY,
  categoryLabel,
  categoryOptions,
  dayGroups,
  dayLabel,
  defaultDay,
  effectiveScores,
  EARLIER_STORAGE_KEY,
  effectiveFilters,
  matchRows,
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
  type ExploreSort,
  type H1bFilter,
  type WorkModelFilter
} from './view'
import classes from './discover.module.css'

const WORK_TONE = { Remote: 'trail', Hybrid: 'neutral', 'On Site': 'neutral' } as const
/** Jobright's work models in the Saved tab's words (#189: "Onsite", as its Workplace filter says). */
const WORK_LABEL = { Remote: 'Remote', Hybrid: 'Hybrid', 'On Site': 'Onsite' } as const
const H1B_TONE = { Yes: 'success', No: 'neutral', 'Not Sure': 'neutral' } as const

/** The visa select in the Saved tab's words (#189), over Jobright's H1B field. */
const VISA_OPTIONS: { value: H1bFilter; label: string }[] = [
  { value: 'all', label: 'Visa: any' },
  { value: 'not-no', label: 'Visa: hide “no sponsorship”' },
  { value: 'yes', label: 'Visa: only sponsors' }
]

const CATEGORY_OPTIONS = categoryOptions()

interface Props {
  /** The saved jobs (the page's list, shared with the Saved tab): a row already among them reads "Saved ✓". */
  saved: readonly Job[]
  /** A row was saved: the page adds it to its list. */
  onSaved(job: Job): void
  /** "Saved ✓" was clicked: the page switches to the Saved tab and opens the job. */
  onOpenSaved(job: Job): void
  /** Draws the page header and the tab switch (the page's), with this tab's eyebrow, subtitle and actions. */
  header(h: TabHeader): ReactNode
}

/**
 * Jobs → Discover (#189; the Explore page of #142, #169): Jobright's jobs of one category from the newgrad-jobs API
 * (the GitHub README when the API fails), grouped by posted day (today first, days past the newest seven folded),
 * cached in the workspace. Every row shows its match score against the master profile (#150), and is saved in one
 * click; a saved row reads "Saved ✓" and opens on the Saved tab.
 */
export function DiscoverTab({ saved, onSaved, onOpenSaved, header }: Props) {
  const { navigate } = useNavigation()
  const [category, setCategory] = useState(readCategory)
  const [list, setList] = useState<ExploreList | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickedDay, setDay] = useState<string | null>(null)
  const [filters, setFilters] = useState<ExploreFilters>(NO_FILTERS)
  const [earlierOpen, setEarlierOpen] = useState(() => readFlag(EARLIER_STORAGE_KEY))
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())
  const [account, setAccount] = useState<JobrightAccount | null>(null)
  /** What the master profile says to score rows on; `null` while loading (an unreadable profile gives no signals). */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)
  const [sort, setSort] = useState<ExploreSort>('newest')
  const [minMatch, setMinMatch] = useState<number | null>(null)
  // The newest request wins: a slow answer for a category left meanwhile is dropped.
  const request = useRef(0)

  useEffect(() => {
    api.explore.account().then(setAccount, () => undefined)
    // Read on every visit: the page is left to edit the profile, so the scores follow its latest version.
    api.profile.read().then(
      (doc) => setSignals(profileSignals(doc.profile)),
      () => setSignals(profileSignals(emptyProfile()))
    )
    // "Updated … ago" stays true while the page is open.
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  /**
   * Whether request `id` is still the newest, and when it is settled, the end of every wait it took over: a Refresh
   * clicked while a list loads (or a list started while a Refresh runs) supersedes it, so the newest request clears
   * both the loader and the Refresh spinner. A superseded one changes nothing on screen.
   */
  const current = (id: number) => id === request.current
  const settle = (id: number) => {
    if (!current(id)) return
    setLoading(false)
    setRefreshing(false)
  }

  // The category's cached list; main fetches it only when the workspace has no copy yet.
  useEffect(() => {
    const id = ++request.current
    setLoading(true)
    // A Refresh still running is for the category left; its answer is dropped.
    setRefreshing(false)
    setError(null)
    api.explore
      .list(category)
      .then(
        (l) => current(id) && setList(l),
        (err) => {
          if (!current(id)) return
          setList(null)
          setError(errorText(err))
        }
      )
      .finally(() => settle(id))
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
      if (!current(id)) return
      setList(l)
      setNow(Date.now())
    } catch (err) {
      // The cached list stays on screen; the error says why it could not be refreshed.
      if (current(id)) setError(errorText(err))
    } finally {
      settle(id)
    }
  }

  async function add(row: ExploreJob) {
    setAdding((s) => new Set(s).add(row.id))
    setError(null)
    try {
      onSaved(await api.explore.add(row.id, category))
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
  // Once per list and profile, never per render: filtering, sorting and the day picker reuse it.
  const rowScores = useMemo(() => (signals ? scoreRows(jobs, signals) : new Map<string, RowScore>()), [jobs, signals])
  const added = useMemo(() => addedJobs(saved), [saved])
  // A saved row shows, filters and sorts by its saved job's score, the number on Saved (#189), also once its full
  // posting is fetched.
  const scores = useMemo(() => effectiveScores(rowScores, added, signals), [rowScores, added, signals])
  const dayRows = useMemo(() => visibleRows(jobs, { day, ...applied }), [jobs, day, applied.text, applied.workModel, applied.h1b, applied.minSalary])
  const rows = useMemo(() => matchRows(dayRows, scores, { sort, minMatch }), [dayRows, scores, sort, minMatch])
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
      {header({
        eyebrow: `Jobright · ${categoryLabel(category)} · ${jobs.length.toLocaleString('en-US')} jobs`,
        subtitle: "New-grad and internship jobs from Jobright's newgrad-jobs list. Save any of them to keep it on the Saved tab.",
        actions: (
          <>
            <MonoLabel size="sm" tone="muted">
              {shownList ? updatedAgo(shownList.fetchedAt, now) : ''}
            </MonoLabel>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        )
      })}

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
              Jobs from this list link Jobright's page. Connect your Jobright account once and jobs you save link the
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
          title="No jobs to discover yet"
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
              aria-label="Workplace"
              value={filters.workModel}
              onChange={(v) => set('workModel', v as WorkModelFilter)}
              data={[{ value: 'all', label: 'Any' }, ...WORK_MODELS.map((w) => ({ value: w, label: WORK_LABEL[w] }))]}
            />
            <Select
              w={190}
              aria-label="Visa sponsorship"
              title={readme ? 'The GitHub list has no H1B details' : 'H1B sponsorship, as Jobright reports it'}
              disabled={readme}
              data={VISA_OPTIONS}
              value={filters.h1b}
              onChange={(v) => set('h1b', (v ?? 'all') as H1bFilter)}
              allowDeselect={false}
            />
            <NumberInput
              w={150}
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
            <NumberInput
              w={130}
              aria-label="Min. match"
              placeholder="Match ≥ …"
              title="Rows whose match score reaches this (a ≈ estimate counts as its number)"
              min={0}
              max={100}
              clampBehavior="strict"
              allowDecimal={false}
              prefix="Match ≥ "
              hideControls
              value={minMatch ?? ''}
              onChange={(v) => setMinMatch(typeof v === 'number' && v > 0 ? v : null)}
            />
            <Select
              w={150}
              aria-label="Sort"
              data={[
                { value: 'newest', label: 'Newest first' },
                { value: 'match', label: 'Best match' }
              ]}
              value={sort}
              onChange={(v) => setSort((v ?? 'newest') as ExploreSort)}
              allowDeselect={false}
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
                const score = scores.get(r.id)
                return (
                  <li key={r.id} className={classes.job} aria-label={`${r.title} at ${r.company}`}>
                    {score ? <MatchBadge score={score} /> : <CompanyAvatar name={r.company} />}
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
                      {r.workModel && <StatusPill tone={WORK_TONE[r.workModel]}>{WORK_LABEL[r.workModel]}</StatusPill>}
                      {savedJob ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          rightSection={<IconCheck size={14} aria-hidden />}
                          title="Open it on the Saved tab"
                          onClick={() => onOpenSaved(savedJob)}
                        >
                          Saved
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          leftSection={<IconPlus size={14} />}
                          loading={adding.has(r.id)}
                          onClick={() => void add(r)}
                        >
                          Save
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
