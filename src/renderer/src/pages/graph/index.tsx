import { useMemo, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Center,
  Chip,
  Grid,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title
} from '@mantine/core'
import { IconRefresh, IconSearch } from '@tabler/icons-react'
import type { NodeKind } from '@shared/knowledge-graph'
import { KIND_COLOR, KIND_LABEL } from '../../components/graph/colors'
import { GraphCanvas } from '../../components/graph/GraphCanvas'
import { NodePanel } from '../../components/graph/NodePanel'
import { SkillsSummaryCard } from '../../components/graph/SkillsSummaryCard'
import { SkillsTable } from '../../components/graph/SkillsTable'
import { useKnowledgeGraph } from '../../components/graph/useKnowledgeGraph'
import { useNavigation, type PageParams } from '../../navigation'

const LEGEND: NodeKind[] = ['person', 'experience', 'company', 'project', 'skill', 'education', 'certification', 'job']

/** Skills, roles, companies and projects from the master profile as a navigable graph, plus a skills table. */
export function GraphPage({ params }: { params: PageParams['graph'] }) {
  const { navigate } = useNavigation()
  const { graph, jobs, error, reload } = useKnowledgeGraph()
  const [view, setView] = useState<'graph' | 'skills'>('graph')
  const [selected, setSelected] = useState<string | null>(params?.nodeId ?? null)
  const [search, setSearch] = useState('')
  const [showJobs, setShowJobs] = useState(true)

  const hiddenKinds = useMemo(() => new Set<NodeKind>(showJobs ? [] : ['job']), [showJobs])
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q || !graph) return null
    return new Set(
      graph.nodes
        .filter((n) => n.label.toLowerCase().includes(q) || n.detail.toLowerCase().includes(q))
        .map((n) => n.id)
    )
  }, [graph, search])

  const sparse = graph && graph.nodes.length <= 1

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Knowledge graph</Title>
        <Group gap="xs">
          <SegmentedControl
            value={view}
            onChange={(v) => setView(v as 'graph' | 'skills')}
            data={[
              { value: 'graph', label: 'Graph' },
              { value: 'skills', label: 'Skills' }
            ]}
          />
          <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={reload}>
            Refresh
          </Button>
        </Group>
      </Group>

      {error && (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}

      {!graph && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {graph && sparse && (
        <Card withBorder radius="md" padding="xl">
          <Stack align="center" gap="xs" py="lg">
            <Title order={3}>Nothing to draw yet</Title>
            <Text c="dimmed" ta="center" maw={520}>
              The graph is built from your master profile: roles, projects, education and skills. Fill it in and come
              back.
            </Text>
            <Button mt="sm" onClick={() => navigate('profile')}>
              Open master profile
            </Button>
          </Stack>
        </Card>
      )}

      {graph && !sparse && (
        <>
          <Group gap="sm" align="center">
            <TextInput
              style={{ flex: 1 }}
              leftSection={<IconSearch size={16} />}
              placeholder={view === 'graph' ? 'Highlight skills, roles, companies…' : 'Filter skills or groups…'}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
            />
            <Chip checked={showJobs} onChange={setShowJobs} disabled={jobs.length === 0}>
              Jobs overlay ({jobs.length})
            </Chip>
          </Group>

          {view === 'graph' ? (
            <Grid gap="md">
              <Grid.Col span={{ base: 12, md: selected ? 8 : 12 }}>
                <Card withBorder radius="md" padding={0}>
                  <GraphCanvas
                    graph={graph}
                    selected={selected}
                    matches={matches}
                    hiddenKinds={hiddenKinds}
                    onSelect={setSelected}
                    height={560}
                  />
                </Card>
                <Group gap="md" mt="xs">
                  {LEGEND.filter((k) => graph.nodes.some((n) => n.kind === k)).map((k) => (
                    <Group key={k} gap={6}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          background: `var(--mantine-color-${KIND_COLOR[k]}-filled)`
                        }}
                      />
                      <Text size="xs" c="dimmed">
                        {KIND_LABEL[k]}
                      </Text>
                    </Group>
                  ))}
                  {graph.skills.some((s) => s.gap) && (
                    <Group gap={6}>
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 5,
                          background: 'var(--mantine-color-orange-filled)'
                        }}
                      />
                      <Text size="xs" c="dimmed">
                        Gap (asked for, not in profile)
                      </Text>
                    </Group>
                  )}
                </Group>
              </Grid.Col>
              {selected && (
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NodePanel graph={graph} id={selected} onSelect={setSelected} />
                </Grid.Col>
              )}
            </Grid>
          ) : (
            <Grid gap="md">
              <Grid.Col span={{ base: 12, md: selected ? 8 : 12 }}>
                <Card withBorder radius="md" padding={0}>
                  <SkillsTable graph={graph} filter={search} onSelect={setSelected} />
                </Card>
              </Grid.Col>
              {selected && (
                <Grid.Col span={{ base: 12, md: 4 }}>
                  <NodePanel graph={graph} id={selected} onSelect={setSelected} />
                </Grid.Col>
              )}
            </Grid>
          )}

          <SkillsSummaryCard graph={graph} showLink={false} />
        </>
      )}
    </Stack>
  )
}
