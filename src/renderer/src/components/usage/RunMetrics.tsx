import { useState } from 'react'
import { Anchor, Collapse, Group, Paper, SimpleGrid, Stack, Table, Text, Tooltip } from '@mantine/core'
import { totalTokens } from '@shared/pricing'
import type { RunSummary } from '@shared/runner-types'
import { formatCost, formatDuration, formatTokens, formatTotalCost, formatUsageDetail, waitingMs } from './format'

export const ESTIMATE_HINT =
  'What these tokens would cost at the model’s API rates. On a subscription (Claude Pro/Max, ChatGPT, Google AI) nothing is billed per token. Prices: Settings → Pricing.'

function Stat({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId: string }) {
  const body = (
    <Stack gap={0}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text size="sm" fw={600} data-testid={testId}>
        {value}
      </Text>
    </Stack>
  )
  return hint ? (
    <Tooltip label={hint} multiline maw={300}>
      {body}
    </Tooltip>
  ) : (
    body
  )
}

/** Active time · waiting time · model · tokens · estimated API cost of one run, and per turn (#44). */
export function RunMetrics({ run }: { run: RunSummary }) {
  const [open, setOpen] = useState(false)
  const t = run.totals
  const metrics = run.metrics ?? []
  if (!t) return null
  const u = t.usage
  return (
    <Paper withBorder radius="md" p="sm" data-testid="run-metrics">
      <SimpleGrid cols={{ base: 2, sm: 5 }} spacing="sm">
        <Stat
          label="Active time"
          testId="metric-active"
          value={formatDuration(t.activeMs)}
          hint="Time the agent worked: from each message to the end of its turn."
        />
        <Stat label="Waiting for you" testId="metric-waiting" value={formatDuration(waitingMs(run))} />
        <Stat label="Model" testId="metric-model" value={run.model ?? 'unknown'} />
        <Stat
          label="Tokens"
          testId="metric-tokens"
          value={formatTokens(totalTokens(u))}
          hint={formatUsageDetail(u)}
        />
        <Stat label="Est. API cost" testId="metric-cost" value={formatTotalCost(t)} hint={ESTIMATE_HINT} />
      </SimpleGrid>
      <Group gap="xs" mt={6}>
        <Text size="xs" c="dimmed">
          {formatUsageDetail(u)}
          {t.reportedCostUsd !== undefined && ` · ${run.agent === 'claude' ? 'Claude' : 'CLI'} reported ${formatCost(t.reportedCostUsd)}`}
          {run.backfilled && ' · rebuilt from the run log (approximate time)'}
        </Text>
        {metrics.length > 0 && (
          <Anchor component="button" size="xs" onClick={() => setOpen((o) => !o)} ml="auto">
            {open ? 'Hide turns' : `Per turn (${metrics.length})`}
          </Anchor>
        )}
      </Group>
      <Collapse expanded={open}>
        <Table mt="xs" fz="xs" withRowBorders={false} data-testid="turn-metrics">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Turn</Table.Th>
              <Table.Th>Time</Table.Th>
              <Table.Th>Model</Table.Th>
              <Table.Th>Tokens</Table.Th>
              <Table.Th>Est. cost</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {metrics.map((m, i) => (
              <Table.Tr key={i}>
                <Table.Td>
                  {m.turn}
                  {!m.ok && ' (did not finish)'}
                </Table.Td>
                <Table.Td>{formatDuration(m.activeMs)}</Table.Td>
                <Table.Td>{m.models && m.models.length > 1 ? m.models.map((x) => x.model).join(' + ') : (m.model ?? 'unknown')}</Table.Td>
                <Table.Td>{formatUsageDetail(m.usage)}</Table.Td>
                <Table.Td>{formatCost(m.estimatedCostUsd)}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Collapse>
    </Paper>
  )
}
