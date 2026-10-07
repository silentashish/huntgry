import { useEffect, useMemo, useState } from 'react'
import {
  ActionBar,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { IconClipboardText, IconEyeOff, IconLink, IconSparkles } from '@tabler/icons-react'
import { DEFAULT_FILTERS, sponsorshipOf, type JobFilters } from '@shared/job-filters'
import { hasRelevanceSignals, profileSignals, relevantJobs, type JobScore, type ProfileSignals } from '@shared/job-relevance'
import { DEFAULT_JOBS_PREFS, type JobsPrefs } from '@shared/jobs-prefs'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useQueue } from '../../components/queue/useQueue'
import { useNavigation } from '../../navigation'
import { QUEUE_STATUS_LABEL } from '../tailor/status'
import { BulkTailorModal } from './BulkTailorModal'
import { JobDrawer } from './JobDrawer'
import { JobFiltersBar } from './JobFiltersBar'
import { prepareTailor } from './handoff'
import { ago, SOURCE_LABEL } from './labels'
import { PasteModal } from './PasteModal'
import { mergeJobs } from './merge'
import { activeQueueItems, selectable, selectAll, selectAllState, selectedJobs, toggle } from './selection'
import { defaultShow, visibleJobs, type Show } from './view'

/**
 * Jobs added by URL or pasted; a job can be sent to the Tailor page. Opens on the saved jobs relevant to the
 * master profile. Huntgry does not search job boards (#78).
 */
export function JobsPage() {
  const { navigate } = useNavigation()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  /** `null` until the user picks a segment: then the default (Relevant when the profile allows) applies. */
  const [pickedShow, setShow] = useState<Show | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  /** Saved per workspace: the list filters. */
  const [prefs, setPrefsState] = useState<JobsPrefs | null>(null)
  /** What the master profile says to match jobs on; `null` while loading (an unreadable profile gives no signals). */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)
  /** Jobs ticked for "Tailor all". */
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [bulkOpen, setBulkOpen] = useState(false)
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
  const scoreOf = useMemo(() => new Map<string, JobScore>(relevant.map((r) => [r.job.id, r.score])), [relevant])
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

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Jobs</Title>
        <Group gap="sm">
          <Button variant="light" leftSection={<IconClipboardText size={16} />} onClick={() => setPasteOpen(true)}>
            Paste a job
          </Button>
        </Group>
      </Group>

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
        <Card withBorder radius="md" padding="xl">
          <Text c="dimmed" ta="center">
            No saved jobs yet. Add a posting by URL above, or paste one.
          </Text>
        </Card>
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
                { value: 'all', label: 'All' },
                { value: 'new', label: 'Not tailored' },
                { value: 'tailored', label: 'Tailored' },
                { value: 'dismissed', label: 'Dismissed' }
              ]}
            />
          </Group>
          <JobFiltersBar filters={filters} onChange={(f) => savePrefs({ filters: f })} />
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
                ? 'No saved job matches your master profile yet. Add one by URL or paste it.'
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
        <Button
          size="xs"
          variant="light"
          color="gray"
          leftSection={<IconEyeOff size={14} />}
          loading={dismissing}
          onClick={() => void dismissSelected()}
        >
          Dismiss
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
