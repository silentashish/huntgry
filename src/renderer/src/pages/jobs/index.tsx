import { useEffect, useMemo, useState } from 'react'
import { Alert, Anchor, Button, Checkbox, Loader, SegmentedControl, Text, TextInput } from '@mantine/core'
import { IconBriefcase, IconClipboardCheck, IconFilter, IconLink, IconPlus, IconSearch, IconSparkles } from '@tabler/icons-react'
import { activeFilterCount, DEFAULT_FILTERS, type JobFilters } from '@shared/job-filters'
import { hasRelevanceSignals, profileSignals, relevantJobs, type ProfileSignals } from '@shared/job-relevance'
import { DEFAULT_JOBS_PREFS, type JobsPrefs } from '@shared/jobs-prefs'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useQueue } from '../../components/queue/useQueue'
import { EmptyState, MonoLabel, PageHeader } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { BulkTailorModal, type BulkMode } from './BulkTailorModal'
import { JobDrawer } from './JobDrawer'
import { JobFiltersBar } from './JobFiltersBar'
import { JobRow } from './JobRow'
import { prepareTailor } from './handoff'
import { PasteModal } from './PasteModal'
import { SelectionBar } from './SelectionBar'
import { mergeJobs } from './merge'
import { activeQueueItems, selectable, selectAll, selectAllState, selectedJobs, toggle } from './selection'
import { defaultShow, scentScores, visibleJobs, type Show } from './view'
import classes from './jobs.module.css'

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/**
 * Jobs added by URL or pasted; a job can be sent to the Tailor page. Opens on the saved jobs relevant to the
 * master profile, each with its Scent score and why it fits. Huntgry does not search job boards (#78).
 */
export function JobsPage() {
  const { navigate } = useNavigation()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(true)
  /** `null` until the user picks a segment: then the default (Relevant when the profile allows) applies. */
  const [pickedShow, setShow] = useState<Show | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  /** Saved per workspace: the list filters. */
  const [prefs, setPrefsState] = useState<JobsPrefs | null>(null)
  /** What the master profile says to match jobs on; `null` while loading (an unreadable profile gives no signals). */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)
  /** Jobs ticked for "Tailor all". */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  /** The Tailor all modal, and the mode it opens in. */
  const [bulk, setBulk] = useState<BulkMode | null>(null)
  const [dismissing, setDismissing] = useState(false)
  const [queue] = useQueue()

  useEffect(() => {
    api.jobs.list().then(setJobs, (err) => setError(errorText(err)))
    api.jobs.prefs().then(setPrefsState, () => setPrefsState(DEFAULT_JOBS_PREFS))
    api.profile.read().then(
      (doc) => setSignals(profileSignals(doc.profile)),
      () => setSignals(profileSignals(emptyProfile()))
    )
  }, [])

  const upsert = (list: Job[]) => setJobs((cur) => mergeJobs(cur ?? [], list))
  const canRelevant = signals !== null && hasRelevanceSignals(signals)
  const show: Show = pickedShow ?? defaultShow(canRelevant)
  const filters = prefs?.filters ?? DEFAULT_FILTERS

  function savePrefs(patch: { filters?: JobFilters }) {
    setPrefsState((p) => ({ ...(p ?? DEFAULT_JOBS_PREFS), ...patch }))
    api.jobs.setPrefs(patch).catch((err) => setError(errorText(err)))
  }

  async function addUrl() {
    setAdding(true)
    setError(null)
    try {
      const job = await api.jobs.addByUrl(url.trim())
      upsert([job])
      setUrl('')
      setOpenId(job.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  /** Sends a job to the Tailor form with everything saved about it (see `prepareTailor`). */
  async function tailor(job: Job) {
    navigate('tailor', tailorPrefillFor(await prepareTailor(job, (j) => upsert([j]))))
  }

  const relevant = useMemo(() => (signals && jobs ? relevantJobs(jobs, signals) : []), [jobs, signals])
  const scores = useMemo(() => scentScores(jobs ?? [], signals, relevant), [jobs, signals, relevant])
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
    upsert(results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])))
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (failed.length > 0) setError(`${failed.length} job(s) could not be dismissed: ${errorText(failed[0].reason)}`)
    setSelection(new Set())
    setDismissing(false)
  }

  const afterBulk = () => {
    setBulk(null)
    setSelection(new Set())
    navigate('tailor', { view: 'queue' })
  }

  return (
    <div className={classes.page}>
      <PageHeader
        eyebrow={`The scent board · ${jobs?.length ?? 0} saved`}
        title="Jobs"
        subtitle={
          canRelevant
            ? 'Ranked by how strongly each posting smells like your master profile.'
            : 'Postings you added by URL or pasted, newest first.'
        }
        actions={
          <>
            <Button variant="default" leftSection={<IconClipboardCheck size={16} />} onClick={() => setPasteOpen(true)}>
              Paste a job
            </Button>
            <Button
              variant="primary"
              leftSection={<IconSparkles size={16} />}
              disabled={selected.length === 0}
              title={selected.length === 0 ? 'Tick the jobs to tailor first' : undefined}
              onClick={() => setBulk('approve')}
            >
              {selected.length > 0 ? `Tailor all (${selected.length})` : 'Tailor all'}
            </Button>
          </>
        }
      />

      {signals && !canRelevant && (
        <Alert variant="light" color="info" title="See the jobs that fit you">
          <Text size="sm">
            Add a headline or a role to your{' '}
            <Anchor component="button" type="button" size="sm" onClick={() => navigate('profile', { section: 'contact' })}>
              master profile
            </Anchor>{' '}
            and the Jobs page opens on the jobs relevant to it, ranked by title, skills, seniority and location.
          </Text>
        </Alert>
      )}

      {error && (
        <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <div className={classes.row}>
        <TextInput
          className={classes.grow}
          leftSection={<IconLink size={16} />}
          placeholder="Add a job by its posting URL (company careers page, Greenhouse, Lever, Ashby, Workday …)"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && isUrl(url) && !adding && void addUrl()}
        />
        <Button variant="secondary" leftSection={<IconPlus size={16} />} onClick={addUrl} loading={adding} disabled={!isUrl(url)}>
          Add
        </Button>
      </div>

      {jobs === null || prefs === null || signals === null ? (
        <Loader />
      ) : jobs.length === 0 ? (
        <EmptyState
          className={classes.empty}
          compact
          icon={<IconBriefcase size={22} />}
          title="No saved jobs yet"
          description="Add a posting by its URL above, or paste one."
          actions={
            <Button variant="default" leftSection={<IconClipboardCheck size={16} />} onClick={() => setPasteOpen(true)}>
              Paste a job
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
                ? 'No saved job matches your master profile yet. Add one by URL or paste it.'
                : 'No relevant job passes these filters.'}
            </p>
          )}
          <ul className={classes.list} aria-label="Saved jobs">
            {shown.map((j) => (
              <JobRow
                key={j.id}
                job={j}
                score={scores.get(j.id)}
                queueItem={queueItemOf(j)}
                selected={selection.has(j.id)}
                selectable={selectable(j)}
                onToggle={() => setSelection((sel) => toggle(sel, j.id))}
                onOpen={() => setOpenId(j.id)}
              />
            ))}
          </ul>
        </>
      )}

      <SelectionBar
        count={selected.length}
        dismissing={dismissing}
        onTailor={() => setBulk('approve')}
        onUnattended={() => setBulk('unattended')}
        onDismiss={() => void dismissSelected()}
        onClear={() => setSelection(new Set())}
      />
      <BulkTailorModal
        jobs={selected}
        opened={bulk !== null}
        initialMode={bulk ?? undefined}
        onClose={() => setBulk(null)}
        onQueued={(res) => {
          if (res.added === 0) {
            setBulk(null)
            setError(`Nothing was queued: ${[...new Set(res.skipped.map((s) => s.reason))].join(' ')}`)
            return
          }
          afterBulk()
        }}
        onStarted={afterBulk}
      />
      <JobDrawer
        job={open}
        score={open ? scores.get(open.id) : undefined}
        onClose={() => setOpenId(null)}
        onChange={(j) => upsert([j])}
        onTailor={tailor}
      />
      <PasteModal
        opened={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSaved={(j) => {
          upsert([j])
          setPasteOpen(false)
          setOpenId(j.id)
        }}
      />
    </div>
  )
}
