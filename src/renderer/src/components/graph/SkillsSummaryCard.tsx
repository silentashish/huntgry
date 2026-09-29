import { Badge, Button, Card, Group, Stack, Text, Title } from '@mantine/core'
import type { KnowledgeGraph } from '@shared/knowledge-graph'
import { useNavigation } from '../../navigation'

/**
 * Compact "top skills / gaps" card for the Dashboard: the best-evidenced skills
 * and the technologies saved job descriptions ask for that the profile lacks.
 */
export function SkillsSummaryCard({
  graph,
  limit = 8,
  showLink = true
}: {
  graph: KnowledgeGraph
  limit?: number
  /** Hide the link to the Knowledge graph page when already on it. */
  showLink?: boolean
}) {
  const { navigate } = useNavigation()
  const top = graph.skills.filter((s) => !s.gap).slice(0, limit)
  const gaps = graph.skills
    .filter((s) => s.gap)
    .sort((a, b) => b.jobs.length - a.jobs.length)
    .slice(0, limit)
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" mb="xs">
        <Title order={4}>Skills</Title>
        {showLink && (
          <Button size="xs" variant="subtle" onClick={() => navigate('graph')}>
            Knowledge graph
          </Button>
        )}
      </Group>
      <Stack gap="sm">
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
            Strongest evidence
          </Text>
          <Group gap={6}>
            {top.map((s) => (
              <Badge key={s.id} variant="light" color="green">
                {s.name}
                {s.years > 0 ? ` · ${s.years}y` : ''}
              </Badge>
            ))}
            {top.length === 0 && (
              <Text size="sm" c="dimmed">
                Add skills and experience to your master profile.
              </Text>
            )}
          </Group>
        </div>
        <div>
          <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
            Asked for, missing from your profile
          </Text>
          <Group gap={6}>
            {gaps.map((s) => (
              <Badge key={s.id} variant="light" color="orange">
                {s.name} · {s.jobs.length} job{s.jobs.length === 1 ? '' : 's'}
              </Badge>
            ))}
            {gaps.length === 0 && (
              <Text size="sm" c="dimmed">
                No gaps found in your saved job descriptions.
              </Text>
            )}
          </Group>
        </div>
      </Stack>
    </Card>
  )
}
