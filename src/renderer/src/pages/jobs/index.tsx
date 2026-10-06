import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionBar,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Chip,
  Group,
  Loader,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { IconClipboardText, IconLink, IconRefresh, IconSearch, IconSparkles } from '@tabler/icons-react'
import { DEFAULT_FILTERS, sponsorshipOf, type JobFilters } from '@shared/job-filters'
import { hasRelevanceSignals, profileSignals, relevantJobs, type JobScore, type ProfileSignals } from '@shared/job-relevance'
import { autoRefreshDue, DEFAULT_JOBS_PREFS, type JobsPrefs } from '@shared/jobs-prefs'
import {
  canFetchDetails,
  tailorPrefillFor,
  type Job,
  type JobQuery,
  type SavedSearch,
  type SearchSource,
  type SourceResult
} from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useQueue } from '../../components/queue/useQueue'
import { useNavigation } from '../../navigation'
import { QUEUE_STATUS_LABEL } from '../tailor/status'
import { BulkTailorModal } from './BulkTailorModal'
import { JobDrawer } from './JobDrawer'
import { JobFiltersBar } from './JobFiltersBar'
import { ago, since, SOURCE_LABEL } from './labels'
import { PasteModal } from './PasteModal'
import { mergeJobs } from './merge'
import { activeQueueItems, selectable, selectAll, selectAllState, selectedJobs, toggle } from './selection'
import { defaultShow, visibleJobs, type Show } from './view'

/**
 * Job search across hiring.cafe and Indeed, jobs added by URL or pasted; a job can be sent to the Tailor page.
 * Opens on the jobs relevant to the master profile, rendered from saved jobs at once; a profile refresh of the
 * boards runs in the background when the last one is over 12 hours old (and auto-refresh is on), or on Refresh.
 */
export function JobsPage() {
  const { navigate } = useNavigation()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [keywords, setKeywords] = useState('')
  const [location, setLocation] = useState('')
  const [remoteOnly, setRemoteOnly] = useState(false)
  const [sources, setSources] = useState<SearchSource[]>(['hiring.cafe', 'indeed'])
  const [searching, setSearching] = useState(false)
  const [report, setReport] = useState<SourceResult[] | null>(null)
  const [recent, setRecent] = useState<SavedSearch[]>([])
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  /** `null` until the user picks a segment: then the default (Relevant when the profile allows) applies. */
  const [pickedShow, setShow] = useState<Show | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  /** Saved per workspace: filters, auto-refresh, the last search's ids (so "Last search" survives leaving the page). */
  const [prefs, setPrefsState] = useState<JobsPrefs | null>(null)
  /** What the master profile says to match jobs on; `null` while loading (an unreadable profile gives no signals). */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  /** Jobs ticked for "Tailor all". */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
  const [queue] = useQueue()

  useEffect(() => {
    api.jobs.list().then(setJobs, (err) => setError(errorText(err)))
    api.jobs.recentSearches().then(setRecent, () => undefined)
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
  const lastIds = useMemo(() => (prefs?.lastSearch ? new Set(prefs.lastSearch.ids) : null), [prefs?.lastSearch])

  function savePrefs(patch: { filters?: JobFilters; autoRefresh?: boolean }) {
    setPrefsState((p) => ({ ...(p ?? DEFAULT_JOBS_PREFS), ...patch }))
    api.jobs.setPrefs(patch).catch((err) => setError(errorText(err)))
  }

  /**
   * Searches the boards with the profile-derived query (its headline near its location), then reloads the
   * saved list. `auto`: the background refresh on open, which leaves the shown segment alone.
   */
  async function refresh(auto = false) {
    setRefreshing(true)
    setError(null)
    if (!auto) setReport(null)
    try {
      const res = await api.jobs.refresh(auto ? { sources: ['hiring.cafe', 'indeed'], auto: true } : { sources })
      // An automatic refresh that main found not due (another window, or the page reopened, refreshed already).
      if (!res) return
      upsert(res.jobs)
      setReport(res.sources)
      setPrefsState((p) => ({
        ...(p ?? DEFAULT_JOBS_PREFS),
        lastRefreshAt: res.at,
        lastSearch: { query: res.query, at: res.at, ids: res.jobs.map((j) => j.id), relevant: true }
      }))
      if (!auto) setShow('relevant')
      api.jobs.list().then(setJobs, () => undefined)
      api.jobs.recentSearches().then(setRecent, () => undefined)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setRefreshing(false)
    }
  }

  // Once the saved jobs, the preferences and the profile are in: refresh in the background when it is due.
  const autoChecked = useRef(false)
  useEffect(() => {
    if (autoChecked.current || jobs === null || prefs === null || signals === null) return
    autoChecked.current = true
    if (canRelevant && autoRefreshDue(prefs)) void refresh(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once, when everything it reads has loaded
  }, [jobs, prefs, signals])

  async function search(q?: JobQuery) {
    const query: JobQuery = q ?? { keywords, location, remoteOnly, sources }
    if (q) {
      setKeywords(q.keywords)
      setLocation(q.location)
      setRemoteOnly(q.remoteOnly)
      setSources(q.sources)
    }
    setSearching(true)
    setError(null)
    setReport(null)
    try {
      const res = await api.jobs.search(query)
      upsert(res.jobs)
      setReport(res.sources)
      setPrefsState((p) => ({
        ...(p ?? DEFAULT_JOBS_PREFS),
        lastSearch: { query, at: new Date().toISOString(), ids: res.jobs.map((j) => j.id), relevant: false }
      }))
      setShow('search')
      setFilter('')
      api.jobs.recentSearches().then(setRecent, () => undefined)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSearching(false)
    }
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

  /**
   * Sends a job to the Tailor form with everything saved about it, so the run never
   * has to read a job board URL (boards block plain HTTP). A summary is first
   * swapped for the employer's full posting when one can be fetched.
   */
  async function tailor(job: Job) {
    let current = job
    if (canFetchDetails(job)) {
      try {
        current = await api.jobs.fetchDetails(job.id)
        upsert([current])
      } catch {
        // Hand off the summary; the Tailor form says it is one.
      }
    }
    try {
      current = await api.jobs.update(job.id, { tailored: true })
      upsert([current])
    } catch {
      // Marking is a convenience; tailoring still works.
    }
    navigate('tailor', tailorPrefillFor(current))
  }

  const relevant = useMemo(() => (signals && jobs ? relevantJobs(jobs, signals) : []), [jobs, signals])
  const scoreOf = useMemo(() => new Map<string, JobScore>(relevant.map((r) => [r.job.id, r.score])), [relevant])
  const shown = useMemo(
    () => visibleJobs({ jobs: jobs ?? [], show, relevant, lastIds, filters, text: filter }),
    [jobs, show, relevant, lastIds, filters, filter]
  )

  // A new search or filter is a new list: start the selection over.
  useEffect(() => setSelection(new Set()), [filter, show, lastIds, filters])

  const selected = selectedJobs(selection, shown)
  const allState = selectAllState(selection, shown)
  const queued = useMemo(() => activeQueueItems(queue?.items ?? []), [queue])
  const queueItemOf = (j: Job) => queued.get(j.id) ?? j.aliases?.map((a) => queued.get(a)).find(Boolean)

  const open = (jobs ?? []).find((j) => j.id === openId) ?? null

  const filtersBar = (p: JobsPrefs) => (
    <JobFiltersBar
      filters={filters}
      onChange={(f) => savePrefs({ filters: f })}
      autoRefresh={p.autoRefresh}
      onAutoRefresh={(on) => savePrefs({ autoRefresh: on })}
    />
  )

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Jobs</Title>
        <Group gap="sm">
          {prefs && canRelevant && (
            <Text size="xs" c="dimmed">
              Relevant jobs updated {since(prefs.lastRefreshAt)}
            </Text>
          )}
          <Button
            variant="light"
            leftSection={<IconRefresh size={16} />}
            loading={refreshing}
            disabled={searching || sources.length === 0 || (!keywords.trim() && !canRelevant)}
            title={
              keywords.trim()
                ? 'Search the boards again for the keywords above'
                : 'Search the boards for jobs like your master profile'
            }
            onClick={() => (keywords.trim() ? void search() : void refresh())}
          >
            Refresh
          </Button>
          <Button variant="light" leftSection={<IconClipboardText size={16} />} onClick={() => setPasteOpen(true)}>
            Paste a job
          </Button>
        </Group>
      </Group>

      <Card withBorder radius="md" padding="md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void search()
          }}
        >
          <Stack gap="sm">
            <Group align="flex-end" gap="sm">
              <TextInput
                style={{ flex: 2 }}
                label="Keywords"
                placeholder="e.g. platform engineer"
                leftSection={<IconSearch size={16} />}
                value={keywords}
                onChange={(e) => setKeywords(e.currentTarget.value)}
              />
              <TextInput
                style={{ flex: 1 }}
                label="Location"
                placeholder="City, state"
                value={location}
                disabled={remoteOnly}
                onChange={(e) => setLocation(e.currentTarget.value)}
              />
              <Button type="submit" loading={searching} disabled={!keywords.trim() || sources.length === 0 || refreshing}>
                Search
              </Button>
            </Group>
            <Group gap="lg">
              <Chip.Group multiple value={sources} onChange={(v) => setSources(v as SearchSource[])}>
                <Group gap="xs">
                  <Chip value="hiring.cafe" size="sm">
                    hiring.cafe
                  </Chip>
                  <Chip value="indeed" size="sm">
                    Indeed
                  </Chip>
                </Group>
              </Chip.Group>
              <Switch
                label="Remote only"
                checked={remoteOnly}
                onChange={(e) => setRemoteOnly(e.currentTarget.checked)}
              />
              {recent.length > 0 && (
                <Group gap={6}>
                  <Text size="xs" c="dimmed">
                    Recent:
                  </Text>
                  {recent.slice(0, 4).map((r) => (
                    <Anchor key={r.at} size="xs" component="button" type="button" onClick={() => void search(r.query)}>
                      {r.query.keywords}
                      {r.query.remoteOnly ? ' (remote)' : r.query.location ? ` · ${r.query.location}` : ''}
                    </Anchor>
                  ))}
                </Group>
              )}
            </Group>
            <Text size="xs" c="dimmed">
              Huntgry opens the board's search page in the background when you click Search or Refresh, and for
              relevant jobs at most every 12 hours when auto-refresh is on. With no keywords, Refresh searches for
              your master profile's headline near its location.
            </Text>
          </Stack>
        </form>
      </Card>

      {searching && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Reading {sources.map((s) => SOURCE_LABEL[s]).join(' and ')}… this takes a few seconds per board.
          </Text>
        </Group>
      )}
      {refreshing && (
        <Group gap="xs">
          <Loader size="xs" />
          <Text size="sm" c="dimmed">
            Refreshing relevant jobs from the boards… the saved ones are listed meanwhile.
          </Text>
        </Group>
      )}

      {signals && !canRelevant && (
        <Alert variant="light" color="blue" title="See the jobs that fit you">
          <Text size="sm">
            Add a headline or a role to your{' '}
            <Anchor component="button" type="button" size="sm" onClick={() => navigate('profile', { section: 'contact' })}>
              master profile
            </Anchor>{' '}
            and the Jobs page opens on the jobs relevant to it, ranked by title, skills, seniority and location.
          </Text>
        </Alert>
      )}

      {report && (
        <SimpleGrid cols={{ base: 1, sm: report.length }}>
          {report.map((r) => (
            <Alert
              key={r.source}
              color={r.status === 'ok' ? (r.count > 0 ? 'green' : 'gray') : r.status === 'blocked' ? 'orange' : 'red'}
              variant="light"
              title={`${SOURCE_LABEL[r.source]}: ${r.status === 'ok' ? `${r.count} job${r.count === 1 ? '' : 's'}` : r.status === 'blocked' ? 'blocked' : 'failed'}`}
            >
              {r.message && <Text size="sm">{r.message}</Text>}
              {r.status === 'blocked' && (
                <Text size="sm" mt={4}>
                  Open the board in your browser and add jobs by URL, or paste the description.
                </Text>
              )}
            </Alert>
          ))}
        </SimpleGrid>
      )}

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Group gap="sm" align="flex-end">
        <TextInput
          style={{ flex: 1 }}
          leftSection={<IconLink size={16} />}
          placeholder="Add a job by its posting URL (company careers page, Greenhouse, Lever, …)"
          value={url}
          onChange={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => e.key === 'Enter' && /^https?:\/\//i.test(url.trim()) && !adding && void addUrl()}
        />
        <Button variant="default" onClick={addUrl} loading={adding} disabled={!/^https?:\/\//i.test(url.trim())}>
          Add
        </Button>
      </Group>

      {jobs === null || prefs === null || signals === null ? (
        <Loader />
      ) : jobs.length === 0 ? (
        <>
          {/* Shown with no saved jobs too: auto-refresh is on by default and must be possible to turn off. */}
          {filtersBar(prefs)}
          <Card withBorder radius="md" padding="xl">
            <Text c="dimmed" ta="center">
              No saved jobs yet. Search the boards above, add a posting by URL, or paste one.
            </Text>
          </Card>
        </>
      ) : (
        <>
          <Group gap="sm">
            <TextInput
              style={{ flex: 1 }}
              placeholder="Filter saved jobs by title, company, location, technology"
              value={filter}
              onChange={(e) => setFilter(e.currentTarget.value)}
            />
            <SegmentedControl
              value={show}
              onChange={(v) => setShow(v as Show)}
              data={[
                ...(canRelevant ? [{ value: 'relevant', label: `Relevant (${relevant.length})` }] : []),
                ...(lastIds
                  ? [
                      {
                        value: 'search',
                        label: `${prefs.lastSearch?.relevant ? 'Last refresh' : 'Last search'} (${lastIds.size})`
                      }
                    ]
                  : []),
                { value: 'all', label: 'All' },
                { value: 'new', label: 'Not tailored' },
                { value: 'tailored', label: 'Tailored' },
                { value: 'dismissed', label: 'Dismissed' }
              ]}
            />
          </Group>
          {filtersBar(prefs)}
          <Group gap="md">
            <Checkbox
              size="xs"
              label={`Select all shown (${shown.filter(selectable).length})`}
              checked={allState === 'all'}
              indeterminate={allState === 'some'}
              disabled={!shown.some(selectable)}
              onChange={() => setSelection(allState === 'all' ? new Set() : selectAll(selection, shown))}
            />
            {selected.length > 0 && (
              <Anchor size="xs" component="button" type="button" onClick={() => setSelection(new Set())}>
                Clear
              </Anchor>
            )}
            <Text size="xs" c="dimmed" ml="auto">
              {shown.length} of {jobs.length} saved jobs
            </Text>
          </Group>
          {show === 'relevant' && shown.length === 0 && (
            <Text size="sm" c="dimmed" ta="center" py="md">
              {relevant.length === 0
                ? 'No saved job matches your master profile yet. Refresh to search the boards for it.'
                : 'No relevant job passes these filters.'}
            </Text>
          )}
          <Stack gap="xs">
            {shown.map((j) => (
              <Card
                key={j.id}
                withBorder
                radius="md"
                padding="sm"
                onClick={() => setOpenId(j.id)}
                style={{ cursor: 'pointer' }}
              >
                <Group justify="space-between" wrap="nowrap" align="flex-start">
                  <Checkbox
                    mt={2}
                    aria-label={`Select ${j.title}`}
                    checked={selection.has(j.id) && selectable(j)}
                    disabled={!selectable(j)}
                    // Ticking selects the job; it must not open the drawer.
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => setSelection((sel) => toggle(sel, j.id))}
                  />
                  <Stack gap={2} style={{ minWidth: 0, flex: 1 }}>
                    <Text fw={600} size="sm" truncate>
                      {j.title}
                    </Text>
                    <Text size="sm" c="dimmed" truncate>
                      {[j.company, j.location, j.salary].filter(Boolean).join(' · ')}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {j.description}
                    </Text>
                    {show === 'relevant' && scoreOf.get(j.id) && (
                      <Text size="xs" c="teal" truncate>
                        {scoreOf.get(j.id)!.reasons.join(' · ')}
                      </Text>
                    )}
                  </Stack>
                  <Stack gap={4} align="flex-end" style={{ flexShrink: 0 }}>
                    <Badge size="sm" variant="light">
                      {SOURCE_LABEL[j.source]}
                    </Badge>
                    {j.remote && (
                      <Badge size="sm" variant="light" color="teal">
                        Remote
                      </Badge>
                    )}
                    {sponsorshipOf(j) === true && (
                      <Badge size="sm" variant="light" color="grape">
                        Sponsors visa
                      </Badge>
                    )}
                    {sponsorshipOf(j) === false && (
                      <Badge size="sm" variant="light" color="orange">
                        No sponsorship
                      </Badge>
                    )}
                    {queueItemOf(j) && (
                      <Badge size="sm" variant="light" color={QUEUE_STATUS_LABEL[queueItemOf(j)!.status].color}>
                        {QUEUE_STATUS_LABEL[queueItemOf(j)!.status].label}
                      </Badge>
                    )}
                    {j.tailoredAt && (
                      <Badge size="sm" variant="light" color="green">
                        Tailored
                      </Badge>
                    )}
                    <Text size="xs" c="dimmed">
                      {ago(j.postedAt)}
                    </Text>
                  </Stack>
                </Group>
              </Card>
            ))}
          </Stack>
        </>
      )}

      <ActionBar opened={selected.length > 0} onClose={() => setSelection(new Set())} aria-label="Selected jobs">
        <Text size="sm" fw={500} px="xs">
          {selected.length} selected
        </Text>
        <ActionBar.Divider />
        <Button size="xs" leftSection={<IconSparkles size={14} />} onClick={() => setBulkOpen(true)}>
          Tailor all
        </Button>
        <Button size="xs" variant="subtle" onClick={() => setSelection(new Set())}>
          Clear
        </Button>
      </ActionBar>
      <BulkTailorModal
        jobs={selected}
        opened={bulkOpen}
        onClose={() => setBulkOpen(false)}
        onQueued={(res) => {
          setBulkOpen(false)
          if (res.added === 0) {
            setError(`Nothing was queued: ${[...new Set(res.skipped.map((s) => s.reason))].join(' ')}`)
            return
          }
          setSelection(new Set())
          navigate('tailor', { view: 'queue' })
        }}
        onStarted={() => {
          setBulkOpen(false)
          setSelection(new Set())
          navigate('tailor', { view: 'queue' })
        }}
      />
      <JobDrawer job={open} onClose={() => setOpenId(null)} onChange={(j) => upsert([j])} onTailor={tailor} />
      <PasteModal
        opened={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSaved={(j) => {
          upsert([j])
          setPasteOpen(false)
          setOpenId(j.id)
        }}
      />
    </Stack>
  )
}
