import { Anchor, Badge, Button, Card, Divider, Group, Stack, Text, Title, UnstyledButton } from '@mantine/core'
import type { GraphNode, KnowledgeGraph } from '@shared/knowledge-graph'
import { useNavigation } from '../../navigation'
import { KIND_COLOR, KIND_LABEL } from './colors'

/** Details of the selected node: for a skill its evidence, years and jobs; otherwise its skills. */
export function NodePanel({ graph, id, onSelect }: { graph: KnowledgeGraph; id: string; onSelect(id: string): void }) {
  const { navigate } = useNavigation()
  const node = graph.nodes.find((n) => n.id === id)
  if (!node) return null
  const skill = graph.skills.find((s) => s.id === id)
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const linked = graph.edges
    .filter((e) => e.source === id || e.target === id)
    .map((e) => byId.get(e.source === id ? e.target : e.source))
    .filter((n): n is GraphNode => n !== undefined)
  const linkedSkills = linked.filter((n) => n.kind === 'skill')
  const linkedOther = linked.filter((n) => n.kind !== 'skill')

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm">
        <div>
          <Badge variant="light" color={skill?.gap ? 'orange' : KIND_COLOR[node.kind]} mb={6}>
            {skill?.gap ? 'Gap' : KIND_LABEL[node.kind]}
          </Badge>
          <Title order={4}>{node.label}</Title>
          {node.detail && (
            <Text size="sm" c="dimmed">
              {node.detail}
            </Text>
          )}
        </div>

        {skill && (
          <>
            <Group gap="xs">
              {skill.years > 0 && <Badge variant="outline">{skill.years} years</Badge>}
              <Badge variant="outline">{skill.evidence.length} evidence</Badge>
              {skill.jobs.length > 0 && (
                <Badge variant="outline" color="orange">
                  {skill.jobs.length} job{skill.jobs.length === 1 ? '' : 's'} ask
                </Badge>
              )}
            </Group>
            {skill.gap ? (
              <Text size="sm">
                Saved job descriptions ask for {skill.name}, but your master profile never mentions it. If you have real
                experience with it, add it; otherwise leave the gap open.
              </Text>
            ) : (
              <Stack gap={6}>
                {skill.evidence.map((ev, i) => (
                  <div key={i}>
                    <Text size="xs" fw={600}>
                      {ev.nodeId ? (
                        <Anchor
                          component="button"
                          type="button"
                          size="xs"
                          fw={600}
                          onClick={() => onSelect(ev.nodeId!)}
                        >
                          {ev.source}
                        </Anchor>
                      ) : (
                        ev.source
                      )}
                    </Text>
                    <Text size="xs" c="dimmed" lineClamp={3}>
                      {ev.text}
                    </Text>
                  </div>
                ))}
              </Stack>
            )}
          </>
        )}

        {!skill && linkedSkills.length > 0 && (
          <div>
            <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
              {node.kind === 'job' ? 'Asks for' : 'Skills'}
            </Text>
            <Group gap={6}>
              {linkedSkills.map((s) => {
                const info = graph.skills.find((x) => x.id === s.id)
                return (
                  <UnstyledButton key={s.id} onClick={() => onSelect(s.id)} aria-label={`Show ${s.label}`}>
                    <Badge variant="light" color={info?.gap ? 'orange' : 'green'} style={{ cursor: 'pointer' }}>
                      {s.label}
                    </Badge>
                  </UnstyledButton>
                )
              })}
            </Group>
          </div>
        )}

        {linkedOther.length > 0 && (
          <>
            <Divider />
            <Stack gap={4}>
              {linkedOther.map((n) => (
                <UnstyledButton key={n.id} onClick={() => onSelect(n.id)}>
                  <Text size="sm">
                    <Text span c={KIND_COLOR[n.kind]} fw={600} size="xs" mr={6}>
                      {KIND_LABEL[n.kind]}
                    </Text>
                    {n.label}
                  </Text>
                </UnstyledButton>
              ))}
            </Stack>
          </>
        )}

        {node.section && (
          <Button size="xs" variant="light" onClick={() => navigate('profile', { section: node.section! })}>
            Edit in master profile
          </Button>
        )}
      </Stack>
    </Card>
  )
}
