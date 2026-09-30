import { Group, SegmentedControl, Stack, Text, Tooltip } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type RunnerEnvironment } from '@shared/runner-types'

interface Props {
  environment: RunnerEnvironment | null
  value: AgentId
  onChange(agent: AgentId): void
  label?: string
  size?: 'xs' | 'sm'
}

/**
 * Claude / Codex / Antigravity. An agent whose CLI or skill is missing is
 * marked, with the reason on hover. It can still be picked, so the form can
 * say what to fix and offer the fix (e.g. "Install skill") in place; starting
 * a run with it stays blocked until then.
 */
export function AgentPicker({ environment, value, onChange, label = 'Agent', size = 'xs' }: Props) {
  return (
    <Stack gap={4}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <SegmentedControl
        size={size}
        value={value}
        onChange={(v) => onChange(v as AgentId)}
        data={AGENT_IDS.map((id) => {
          const s = environment?.agents.find((a) => a.id === id)
          const name = `${AGENT_LABEL[id]}${id === environment?.defaultAgent ? ' (default)' : ''}`
          if (!s || s.ready) return { value: id, label: name }
          return {
            value: id,
            label: (
              <Tooltip label={s.problems[0]} multiline w={300} withArrow>
                <Group gap={4} wrap="nowrap" justify="center" aria-label={`${name}: not available`}>
                  <IconAlertTriangle size={12} color="var(--mantine-color-orange-6)" />
                  <span>{name}</span>
                </Group>
              </Tooltip>
            )
          }
        })}
      />
    </Stack>
  )
}

/** The status of `agent` in the environment report, when known. */
export function agentStatus(environment: RunnerEnvironment | null, agent: AgentId) {
  return environment?.agents.find((a) => a.id === agent) ?? null
}
