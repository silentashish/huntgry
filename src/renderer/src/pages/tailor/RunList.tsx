import { Badge, Button, Group, NavLink, ScrollArea, Stack, Text } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import type { RunSummary } from '@shared/runner-types'
import { AGENT_LABEL } from '@shared/runner-types'
import { AGENT_COLOR, runStatusLabel, STATUS_LABEL } from './status'

interface Props {
  runs: RunSummary[]
  selected: string | null
  onSelect(id: string | null): void
}

/** Past and active runs of this workspace, newest first. */
export function RunList({ runs, selected, onSelect }: Props) {
  const waiting = runs.filter((r) => r.status === 'waiting').length
  return (
    <Stack gap="xs">
      <Button
        leftSection={<IconPlus size={16} />}
        variant={selected === null ? 'filled' : 'light'}
        onClick={() => onSelect(null)}
      >
        New run
      </Button>
      {waiting > 0 && (
        <Text size="xs" c="yellow.8" px="xs">
          {waiting} run{waiting === 1 ? '' : 's'} waiting for your reply
        </Text>
      )}
      <ScrollArea.Autosize mah="calc(100vh - 180px)">
        {runs.length === 0 && (
          <Text size="sm" c="dimmed" p="xs">
            No runs yet in this workspace.
          </Text>
        )}
        {runs.map((r) => (
          <NavLink
            key={r.id}
            active={r.id === selected}
            onClick={() => onSelect(r.id)}
            label={
              <Text size="sm" fw={500} truncate>
                {r.title}
              </Text>
            }
            description={
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  {new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </Text>
                <Group gap={4}>
                  <Badge size="xs" variant="outline" color={AGENT_COLOR[r.agent]}>
                    {AGENT_LABEL[r.agent]}
                  </Badge>
                  <Badge size="xs" variant="light" color={STATUS_LABEL[r.status].color}>
                    {runStatusLabel(r.status, r.agent)}
                  </Badge>
                </Group>
              </Stack>
            }
            style={{ borderRadius: 'var(--mantine-radius-md)' }}
          />
        ))}
      </ScrollArea.Autosize>
    </Stack>
  )
}
