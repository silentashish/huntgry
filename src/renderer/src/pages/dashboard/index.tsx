import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Center,
  Group,
  Loader,
  MultiSelect,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip
} from '@mantine/core'
import { IconFileTypePdf, IconFolder, IconRefresh, IconSearch, IconSend, IconWorld } from '@tabler/icons-react'
import {
  APPLICATION_STATUSES,
  type ApplicationRecord,
  type ApplicationsList,
  type ApplicationStatus,
  type ApplicationTracking
} from '@shared/applications-types'
import { api, errorText } from '../../api'
import { APPLY_HINT, applyBlocker } from '../../components/apply/blocker'
import { useApply } from '../../components/apply/useApply'
import { SkillsSummaryCard } from '../../components/graph/SkillsSummaryCard'
import { useKnowledgeGraph } from '../../components/graph/useKnowledgeGraph'
import { useNavigation } from '../../navigation'
import { ApplicationDrawer, BuildBadge } from './ApplicationDrawer'
import { LastPipelineCard } from './LastPipelineCard'
import { UsageCard } from './UsageCard'
import { ReviewBadge } from './ReviewBadge'
import { PROFILE_SAVED_EVENT, ProfileInsightsCard } from './ProfileInsightsCard'
import { countByStatus, DEFAULT_FILTER, filterApplications, type Filter, type SortKey } from './filter'
import { STATUS_META } from './status'

const SUMMARY: ApplicationStatus[] = ['generated', 'applied', 'interviewing', 'offer', 'rejected']

/** Every generated resume and cover letter in the workspace, with tracking and links to the job postings. */
export function DashboardPage() {
  const { navigate } = useNavigation()
  const [list, setList] = useState<ApplicationsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>(DEFAULT_FILTER)
  const [openId, setOpenId] = useState<string | null>(null)
  const applier = useApply(setError)

  // Bumped by every successful tracking update; a list() that started before it may hold stale tracking.
  const generation = useRef(0)

  // Mount, focus and file-watch events can overlap; only the latest list call may update the page.
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    const started = generation.current
    try {
      const next = await api.applications.list()
      if (latestLoad.current !== request || generation.current !== started) return
      setList(next)
      setError(null)
    } catch (err) {
      // A newer load or a tracking update has superseded this request: its error is stale too.
      if (latestLoad.current !== request || generation.current !== started) return
      setError(errorText(err))
    }
  }, [])

  // Initial load, then re-list when the workspace changes on disk or the window regains focus.
  useEffect(() => {
    void load()
    const off = api.on('applications:changed', () => void load())
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const apps = useMemo(() => list?.applications ?? [], [list])
  const shown = useMemo(() => filterApplications(apps, filter), [apps, filter])
  const counts = useMemo(() => countByStatus(apps), [apps])
  const open = apps.find((a) => a.id === openId) ?? null

  async function update(id: string, patch: Partial<ApplicationTracking>) {
    const next = await api.applications.updateTracking(id, patch)
    generation.current++
    setList((l) => l && { ...l, applications: l.applications.map((a) => (a.id === id ? next : a)) })
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Dashboard</Title>
        <Group gap="xs">
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>
            Refresh
          </Button>
          <Button onClick={() => navigate('tailor')}>New tailored resume</Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {list === null && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {list && <LastPipelineCard />}

      {list && <UsageCard onOpenRun={(runId) => navigate('tailor', { runId })} />}

      {list && apps.length === 0 && (
        <Card withBorder radius="md" padding="xl">
          <Stack align="center" gap="xs" py="lg">
            <Title order={3}>No applications yet</Title>
            <Text c="dimmed" ta="center" maw={520}>
              Every resume the skill builds lands in this workspace as <code>role/company/job-id/</code> and shows up
              here. Find a job or paste one to get started.
            </Text>
            <Group mt="sm">
              <Button variant="light" onClick={() => navigate('jobs')}>
                Find jobs
              </Button>
              <Button onClick={() => navigate('tailor')}>Tailor for a job</Button>
            </Group>
          </Stack>
        </Card>
      )}

      {list && apps.length > 0 && (
        <>
          <SimpleGrid cols={{ base: 3, md: 6 }}>
            <StatCard
              label="Total"
              value={apps.length}
              active={filter.statuses.length === 0}
              onClick={() => setFilter({ ...filter, statuses: [] })}
            />
            {SUMMARY.map((s) => (
              <StatCard
                key={s}
                label={STATUS_META[s].label}
                color={STATUS_META[s].color}
                value={counts[s]}
                active={filter.statuses.length === 1 && filter.statuses[0] === s}
                onClick={() => setFilter({ ...filter, statuses: [s] })}
              />
            ))}
          </SimpleGrid>

          <Group gap="sm" align="flex-end">
            <TextInput
              style={{ flex: 1 }}
              leftSection={<IconSearch size={16} />}
              aria-label="Search applications"
              placeholder="Search company, role, title, notes"
              value={filter.text}
              onChange={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
            />
            <MultiSelect
              w={260}
              aria-label="Filter by status"
              placeholder={filter.statuses.length ? undefined : 'All but archived'}
              data={APPLICATION_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))}
              value={filter.statuses}
              onChange={(v) => setFilter({ ...filter, statuses: v as ApplicationStatus[] })}
              clearable
            />
            <Select
              aria-label="Sort applications"
              w={150}
              data={[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
                { value: 'company', label: 'Company' }
              ]}
              value={filter.sort}
              allowDeselect={false}
              onChange={(v) => v && setFilter({ ...filter, sort: v as SortKey })}
            />
          </Group>

          {list.truncated && (
            <Alert color="yellow" variant="light">
              The workspace is large; the scan stopped early and some applications may be missing.
            </Alert>
          )}

          <Paper withBorder radius="md">
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Application</Table.Th>
                  <Table.Th w={120}>Created</Table.Th>
                  <Table.Th w={160}>Status</Table.Th>
                  <Table.Th w={150}>Build</Table.Th>
                  <Table.Th w={180} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((a) => (
                  <Row
                    key={a.id}
                    app={a}
                    onOpen={() => setOpenId(a.id)}
                    onUpdate={(p) => act(() => update(a.id, p))}
                    onAct={act}
                    onApply={() => applier.apply(a)}
                    applying={applier.busy}
                  />
                ))}
                {shown.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5}>
                      <Text c="dimmed" ta="center" py="md">
                        Nothing matches.{' '}
                        <Anchor component="button" onClick={() => setFilter(DEFAULT_FILTER)}>
                          Clear filters
                        </Anchor>
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                )}
              </Table.Tbody>
            </Table>
          </Paper>
        </>
      )}

      <SimpleGrid cols={{ base: 1, md: 2 }}>
        <ProfileInsightsCard />
        <DashboardSkills />
      </SimpleGrid>

      <ApplicationDrawer
        app={open}
        onClose={() => setOpenId(null)}
        onUpdate={(p) => update(open!.id, p)}
        onApply={(a) => applier.apply(a)}
        applying={applier.busy}
      />
      {applier.modal}
    </Stack>
  )
}

/** The knowledge graph's "Strongest evidence / asked for, missing" card; nothing until the profile has skills. */
function DashboardSkills() {
  const { graph, reload } = useKnowledgeGraph()
  // Same triggers as the application list: new or changed job descriptions change the job counts and gaps.
  useEffect(() => {
    const off = api.on('applications:changed', reload)
    window.addEventListener('focus', reload)
    window.addEventListener(PROFILE_SAVED_EVENT, reload)
    return () => {
      off()
      window.removeEventListener('focus', reload)
      window.removeEventListener(PROFILE_SAVED_EVENT, reload)
    }
  }, [reload])
  if (!graph || graph.skills.length === 0) return null
  return <SkillsSummaryCard graph={graph} />
}

function StatCard(props: { label: string; value: number; color?: string; active: boolean; onClick(): void }) {
  return (
    <Card
      withBorder
      radius="md"
      padding="sm"
      onClick={props.onClick}
      style={{ cursor: 'pointer', borderColor: props.active ? 'var(--mantine-primary-color-filled)' : undefined }}
    >
      <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
        {props.label}
      </Text>
      <Text size="xl" fw={700} c={props.color && props.color !== 'gray' && props.value > 0 ? props.color : undefined}>
        {props.value}
      </Text>
    </Card>
  )
}

interface RowProps {
  app: ApplicationRecord
  onOpen(): void
  onUpdate(patch: Partial<ApplicationTracking>): void
  onAct(fn: () => Promise<unknown>): void
  onApply(): void
  /** An Apply is starting; every row's Apply waits for it. */
  applying: boolean
}

function Row({ app, onOpen, onUpdate, onAct, onApply, applying }: RowProps) {
  const { navigate } = useNavigation()
  const has = (f: string) => app.files.includes(f)
  // Controls inside the row must not also open the drawer.
  const stop = (e: React.MouseEvent) => e.stopPropagation()
  const dot = `var(--mantine-color-${STATUS_META[app.tracking.status].color}-filled)`
  return (
    <Table.Tr onClick={onOpen} style={{ cursor: 'pointer' }}>
      <Table.Td>
        <Text fw={600} size="sm">
          {app.company}
        </Text>
        <Text size="sm">{app.role}</Text>
        {app.jobTitle && app.jobTitle !== app.role && (
          <Text size="xs" c="dimmed" lineClamp={1}>
            {app.jobTitle}
          </Text>
        )}
        {app.tracking.source && (
          <Badge size="xs" variant="outline" color="gray" mt={4}>
            {app.tracking.source}
          </Badge>
        )}
      </Table.Td>
      <Table.Td>
        <Text size="sm">{new Date(app.createdAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}</Text>
        {app.tracking.appliedAt && (
          <Text size="xs" c="dimmed">
            applied {app.tracking.appliedAt}
          </Text>
        )}
      </Table.Td>
      <Table.Td onClick={stop}>
        <Select
          size="xs"
          data={APPLICATION_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))}
          value={app.tracking.status}
          allowDeselect={false}
          onChange={(v) => v && onUpdate({ status: v as ApplicationStatus })}
          leftSection={<span style={{ width: 8, height: 8, borderRadius: 4, background: dot }} />}
        />
      </Table.Td>
      <Table.Td>
        <Group gap={4}>
          <BuildBadge app={app} short />
          <ReviewBadge app={app} short />
        </Group>
      </Table.Td>
      <Table.Td onClick={stop}>
        <Group gap={4} justify="flex-end" wrap="nowrap">
          <Tooltip label={applyBlocker(app) ?? APPLY_HINT} multiline maw={260}>
            <ActionIcon
              variant="subtle"
              color="teal"
              disabled={applyBlocker(app) !== null || applying}
              onClick={onApply}
              aria-label="Apply"
            >
              <IconSend size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Open resume PDF">
            <ActionIcon
              variant="subtle"
              disabled={!has('resume.pdf')}
              onClick={() => onAct(() => api.applications.openFile(app.id, 'resume.pdf'))}
              aria-label="Open resume"
            >
              <IconFileTypePdf size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Open cover letter PDF">
            <ActionIcon
              variant="subtle"
              color="grape"
              disabled={!has('cover.pdf')}
              onClick={() => onAct(() => api.applications.openFile(app.id, 'cover.pdf'))}
              aria-label="Open cover letter"
            >
              <IconFileTypePdf size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label={app.jobUrl ?? 'No posting URL'}>
            <ActionIcon
              variant="subtle"
              color="gray"
              disabled={!app.jobUrl}
              onClick={() => app.jobUrl && navigate('browser', { url: app.jobUrl })}
              aria-label="Open job posting"
            >
              <IconWorld size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Show in Finder">
            <ActionIcon
              variant="subtle"
              color="gray"
              onClick={() => onAct(() => api.applications.reveal(app.id))}
              aria-label="Show in Finder"
            >
              <IconFolder size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  )
}
