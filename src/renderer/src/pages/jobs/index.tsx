import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
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
import { IconClipboardText, IconLink, IconSearch } from '@tabler/icons-react'
import {
  canFetchDetails,
  tailorPrefillFor,
  type Job,
  type JobQuery,
  type SavedSearch,
  type SearchSource,
  type SourceResult
} from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { useNavigation } from '../../navigation'
import { JobDrawer } from './JobDrawer'
import { ago, SOURCE_LABEL } from './labels'
import { PasteModal } from './PasteModal'
import { mergeJobs } from './merge'

type Show = 'search' | 'all' | 'new' | 'tailored' | 'dismissed'

/** Job search across hiring.cafe and Indeed, jobs added by URL or pasted; a job can be sent to the Tailor page. */
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
  const [show, setShow] = useState<Show>('all')
  const [openId, setOpenId] = useState<string | null>(null)
  /** Jobs returned by the last search, shown by default right after it. */
  const [lastIds, setLastIds] = useState<Set<string> | null>(null)

  useEffect(() => {
    api.jobs.list().then(setJobs, (err) => setError(errorText(err)))
    api.jobs.recentSearches().then(setRecent, () => undefined)
  }, [])

  const upsert = (list: Job[]) => setJobs((cur) => mergeJobs(cur ?? [], list))

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
      setLastIds(new Set(res.jobs.map((j) => j.id)))
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

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (jobs ?? []).filter((j) => {
      if (show === 'search' && !lastIds?.has(j.id)) return false
      if (show === 'dismissed' ? !j.dismissed : j.dismissed) return false
      if (show === 'new' && j.tailoredAt) return false
      if (show === 'tailored' && !j.tailoredAt) return false
      return !q || [j.title, j.company, j.location, j.tags.join(' ')].some((s) => s.toLowerCase().includes(q))
    })
  }, [jobs, filter, show, lastIds])

  const open = (jobs ?? []).find((j) => j.id === openId) ?? null

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Jobs</Title>
        <Button variant="light" leftSection={<IconClipboardText size={16} />} onClick={() => setPasteOpen(true)}>
          Paste a job
        </Button>
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
              <Button type="submit" loading={searching} disabled={!keywords.trim() || sources.length === 0}>
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
              Huntgry opens the board's search page once, in the background, only when you click Search.
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

      {jobs === null ? (
        <Loader />
      ) : jobs.length === 0 ? (
        <Card withBorder radius="md" padding="xl">
          <Text c="dimmed" ta="center">
            No saved jobs yet. Search the boards above, add a posting by URL, or paste one.
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
                ...(lastIds ? [{ value: 'search', label: `Last search (${lastIds.size})` }] : []),
                { value: 'all', label: 'All' },
                { value: 'new', label: 'Not tailored' },
                { value: 'tailored', label: 'Tailored' },
                { value: 'dismissed', label: 'Dismissed' }
              ]}
            />
          </Group>
          <Text size="xs" c="dimmed">
            {shown.length} of {jobs.length} saved jobs
          </Text>
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
                  <Stack gap={2} style={{ minWidth: 0 }}>
                    <Text fw={600} size="sm" truncate>
                      {j.title}
                    </Text>
                    <Text size="sm" c="dimmed" truncate>
                      {[j.company, j.location, j.salary].filter(Boolean).join(' · ')}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={2}>
                      {j.description}
                    </Text>
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
