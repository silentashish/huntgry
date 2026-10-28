import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Alert, Anchor, Button, Checkbox, Loader, SegmentedControl, Text, TextInput } from '@mantine/core'
import { IconBookmark, IconCompass, IconFilter, IconSearch, IconSparkles } from '@tabler/icons-react'
import { activeFilterCount, DEFAULT_FILTERS, type JobFilters } from '@shared/job-filters'
import { hasRelevanceSignals, profileSignals, type ProfileSignals } from '@shared/job-relevance'
import { DEFAULT_JOBS_PREFS, type JobsPrefs } from '@shared/jobs-prefs'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useQueue } from '../../components/queue/useQueue'
import { EmptyState, MonoLabel } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { BulkTailorModal } from './BulkTailorModal'
import { JobDrawer } from './JobDrawer'
import { JobFiltersBar } from './JobFiltersBar'
import { JobRow } from './JobRow'
import { prepareTailor } from './handoff'
import { SelectionBar } from './SelectionBar'
import { activeQueueItems, selectable, selectAll, selectAllState, selectedJobs, toggle } from './selection'
import type { TabHeader } from './tabs'
import { defaultShow, relevanceView, visibleJobs, type Show } from './view'
import classes from './jobs.module.css'

interface Props {
  /** The saved jobs (the page's list, shared with Discover); `null` while loading. */
  jobs: Job[] | null
  /** Saved changes to merge into the list. */
  onUpsert(jobs: Job[]): void
  /** The job whose drawer is open. */
  openId: string | null
  onOpen(id: string | null): void
  /** Switches to the Discover tab. */
  onDiscover(): void
  /** Draws the page header and the tab switch (the page's), with this tab's eyebrow, subtitle and actions. */
  header(h: TabHeader): ReactNode
}

/**
 * Jobs → Saved (#189; the Jobs page of #78, #111): the jobs you saved from Discover, by link or as text; a job can
 * be sent to the Tailor page. Opens on the saved jobs relevant to the master profile (ranked by relevance, #73),
 * each with its match score (#149, the number Discover shows) and why it fits.
 */
export function SavedTab({ jobs, onUpsert, openId, onOpen, onDiscover, header }: Props) {
  const { navigate } = useNavigation()
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)
  /** `null` until the user picks a segment: then the default (Relevant when the profile allows) applies. */
  const [pickedShow, setShow] = useState<Show | null>(null)
  /** Saved per workspace: the list filters. */
  const [prefs, setPrefsState] = useState<JobsPrefs | null>(null)
  /** What the master profile says to match jobs on; `null` while loading (an unreadable profile gives no signals). */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)
  /** Jobs ticked for "Tailor all". */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /** The Tailor all modal, and the mode it opens in. */
  const [bulk, setBulk] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [queue] = useQueue()

  useEffect(() => {
    api.jobs.prefs().then(setPrefsState, () => setPrefsState(DEFAULT_JOBS_PREFS))
    api.profile.read().then(
      (doc) => setSignals(profileSignals(doc.profile)),
      () => setSignals(profileSignals(emptyProfile()))
    )
  }, [])

  const canRelevant = signals !== null && hasRelevanceSignals(signals)
  const show: Show = pickedShow ?? defaultShow(canRelevant)
  const filters = prefs?.filters ?? DEFAULT_FILTERS

  function savePrefs(patch: { filters?: JobFilters }) {
    setPrefsState((p) => ({ ...(p ?? DEFAULT_JOBS_PREFS), ...patch }))
    api.jobs.setPrefs(patch).catch((err) => setError(errorText(err)))
  }

  /** Sends a job to the Tailor form with everything saved about it (see `prepareTailor`). */
  async function tailor(job: Job) {
    navigate('tailor', tailorPrefillFor(await prepareTailor(job, (j) => onUpsert([j]))))
  }

  // One scoring pass: every job's relevance and match score, and the Relevant list ranked from the same scores.
  const { scores, relevant, matches } = useMemo(() => relevanceView(jobs ?? [], signals), [jobs, signals])
  const shown = useMemo(
    () => visibleJobs({ jobs: jobs ?? [], show, relevant, filters, text: filter }),
    [jobs, show, relevant, filters, filter]
  )

  // A new filter is a new list: start the selection over.
  useEffect(() => setSelection(new Set()), [filter, show, filters])

  const selected = selectedJobs(selection, shown)
  const allState = selectAllState(selection, shown)
  const queued = useMemo(() => activeQueueItems(queue?.items ?? []), [queue])
  const queueItemOf = (j: Job) => queued.get(j.id) ?? j.aliases?.map((a) => queued.get(a)).find(Boolean)
  const filterCount = activeFilterCount(filters)

  const open = (jobs ?? []).find((j) => j.id === openId) ?? null

  /** Dismisses every selected job (#92); the ones that saved stay dismissed even if another fails. */
  async function dismissSelected() {
    setDismissing(true)
    setError(null)
    const results = await Promise.allSettled(selected.map((j) => api.jobs.update(j.id, { dismissed: true })))
    onUpsert(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])))
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed.length > 0) setError(`${failed.length} job(s) could not be dismissed: ${errorText(failed[0].reason)}`)
    setSelection(new Set())
    setDismissing(false)
  }

  const afterBulk = () => {
    setBulk(false)
    setSelection(new Set())
    navigate('tailor', { view: 'queue' })
  }

  return (
    <div className={classes.page}>
      {header({
        eyebrow: `Saved jobs · ${jobs?.length ?? 0} saved`,
        subtitle: canRelevant
          ? 'Ranked by how well each posting fits your master profile.'
          : 'Postings you saved from Discover, by link or as text, newest first.',
        actions: (
          <Button
            variant="primary"
            leftSection={<IconSparkles size={16} />}
            disabled={selected.length === 0}
            title={selected.length === 0 ? 'Tick the jobs to tailor first' : undefined}
            onClick={() => setBulk(true)}
          >
            {selected.length > 0 ? `Tailor all (${selected.length})` : 'Tailor all'}
          </Button>
        )
      })}

      {signals && !canRelevant && (
        <Alert variant="light" color="info" title="See the jobs that fit you">
          <Text size="sm">
            Add a headline or a role to your{' '}
            <Anchor component="button" type="button" size="sm" onClick={() => navigate('profile', { section: 'contact' })}>
              master profile
            </Anchor>{' '}
            and the Saved tab opens on the jobs relevant to it, ranked by title, skills, seniority and location.
          </Text>
        </Alert>
      )}

      {error && (
        <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {jobs === null || prefs === null || signals === null ? (
        <Loader />
      ) : jobs.length === 0 ? (
        <EmptyState
          className={classes.empty}
          compact
          icon={<IconBookmark size={22} />}
          title="No saved jobs yet"
          description="Save one from Discover, or add a posting by its link or text with Add job."
          actions={
            <Button variant="default" leftSection={<IconCompass size={16} />} onClick={onDiscover}>
              Discover jobs
            </Button>
          }
        />
      ) : (
        <>
          <div className={classes.row}>
            <SegmentedControl
              value={show}
              onChange={(v) => setShow(v as Show)}
              data={[
                ...(canRelevant ? [{ value: 'relevant', label: `Relevant (${relevant.length})` }] : []),
                { value: 'all', label: 'All' },
                { value: 'new', label: 'Not tailored' },
                { value: 'tailored', label: 'Tailored' },
                { value: 'dismissed', label: 'Dismissed' }
              ]}
            />
            <TextInput
              className={classes.grow}
              leftSection={<IconSearch size={16} />}
              placeholder="Filter by title, company, location, technology"
              aria-label="Filter saved jobs"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
            <Button
              variant="default"
              leftSection={<IconFilter size={16} />}
              aria-expanded={filtersOpen}
              aria-controls="jobs-filters"
              onClick={() => setFiltersOpen((o) => !o)}
            >
              {filterCount > 0 ? `Filters · ${filterCount}` : 'Filters'}
            </Button>
          </div>
          <JobFiltersBar
            filters={filters}
            onChange={(f) => savePrefs({ filters: f })}
            open={filtersOpen}
            footer={
              <div className={classes.selectAll}>
                <Checkbox
                  size="xs"
                  label={`Select all shown (${shown.filter(selectable).length})`}
                  checked={allState === 'all'}
                  indeterminate={allState === 'some'}
                  disabled={!shown.some(selectable)}
                  onChange={() => setSelection(allState === 'all' ? new Set() : selectAll(selection, shown))}
                />
                <span className={classes.dot} aria-hidden>
                  ·
                </span>
                <MonoLabel>
                  {shown.length} of {jobs.length} saved jobs
                </MonoLabel>
              </div>
            }
          />
          {show === 'relevant' && shown.length === 0 && (
            <p className={classes.note}>
              {relevant.length === 0
                ? 'No saved job matches your master profile yet. Save one from Discover or add one.'
                : 'No relevant job passes these filters.'}
            </p>
          )}
          <ul className={classes.list} aria-label="Saved jobs">
            {shown.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                match={matches.get(j.id)}
                relevance={scores.get(j.id)}
                queueItem={queueItemOf(j)}
                selected={selection.has(j.id)}
                selectable={selectable(j)}
                onToggle={() => setSelection((sel) => toggle(sel, j.id))}
                onOpen={() => onOpen(j.id)}
              />
            ))}
          </ul>
        </>
      )}

      <SelectionBar
        count={selected.length}
        dismissing={dismissing}
        onTailor={() => setBulk(true)}
        onDismiss={() => void dismissSelected()}
        onClear={() => setSelection(new Set())}
      />
      <BulkTailorModal jobs={selected} opened={bulk} onClose={() => setBulk(false)} onStarted={afterBulk} />
      <JobDrawer
        job={open}
        match={open ? matches.get(open.id) : undefined}
        relevance={open ? scores.get(open.id) : undefined}
        onClose={() => onOpen(null)}
        onChange={(j) => onUpsert([j])}
        onTailor={tailor}
      />
    </div>
  )
}
