import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  MultiSelect,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Text,
  Title,
  Tooltip
} from '@mantine/core'
import { IconChartBar, IconDownload } from '@tabler/icons-react'
import { totalTokens } from '@shared/pricing'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type RunStatus } from '@shared/runner-types'
import type { UsageFilter, UsageRange, UsageSummary } from '@shared/usage-types'
import { api, errorText } from '../../api'
import { formatCost, formatDuration, formatTokens, formatTotalCost } from '../../components/usage/format'
import { ESTIMATE_HINT } from '../../components/usage/RunMetrics'
import { STATUS_LABEL } from '../tailor/status'

const RANGE_LABEL: Record<UsageRange, string> = { '7d': '7 days', '30d': '30 days', all: 'All time' }
const STATUSES: RunStatus[] = ['finished', 'failed', 'stopped', 'waiting', 'running']

function Kpi({ label, value, sub, testId, hint }: { label: string; value: string; sub?: string; testId: string; hint?: string }) {
  const body = (
    <Paper withBorder radius="md" p="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="lg" data-testid={testId}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed">
          {sub}
        </Text>
      )}
    </Paper>
  )
  return hint ? (
    <Tooltip label={hint} multiline maw={300}>
      {body}
    </Tooltip>
  ) : (
    body
  )
}

/** Cost (or tokens) per day, as plain bars: one per day with a turn. */
function DayChart({ summary }: { summary: UsageSummary }) {
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const days = summary.byDay.slice(-60)
  if (days.length === 0) return null
  const value = (d: (typeof days)[number]) => (metric === 'cost' ? d.estimatedCostUsd : d.tokens)
  const max = Math.max(...days.map(value), 0) || 1
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="sm" fw={600}>
          Per day
        </Text>
        <SegmentedControl
          size="xs"
          value={metric}
          onChange={(v) => setMetric(v as 'cost' | 'tokens')}
          data={[
            { value: 'cost', label: 'Est. cost' },
            { value: 'tokens', label: 'Tokens' }
          ]}
        />
      </Group>
      <Group gap={3} align="flex-end" h={90} wrap="nowrap" style={{ overflowX: 'auto' }} data-testid="usage-chart">
        {days.map((d) => (
          <Tooltip
            key={d.day}
            label={`${d.day}: ${formatCost(d.estimatedCostUsd)} · ${formatTokens(d.tokens)} tokens · ${formatDuration(d.activeMs)}`}
          >
            <Box
              w={14}
              miw={6}
              h={`${Math.max(2, (value(d) / max) * 100)}%`}
              bg="blue.5"
              style={{ borderRadius: 2, flexShrink: 0 }}
              aria-label={`${d.day} ${metric === 'cost' ? formatCost(d.estimatedCostUsd) : formatTokens(d.tokens)}`}
            />
          </Tooltip>
        ))}
      </Group>
    </Stack>
  )
}

/**
 * Totals across tailoring runs (#44): run time, tokens and estimated API cost, filterable by date,
 * agent, model and status, split by agent × model and per "Tailor all" batch. Every number comes
 * from the main process (`runner:usage-summary`), summed from the runs' per-turn metrics.
 */
export function UsageCard({ onOpenRun }: { onOpenRun(runId: string): void }) {
  const [filter, setFilter] = useState<UsageFilter>({ range: '30d' })
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const latest = useRef(0)

  const load = useCallback(async (f: UsageFilter) => {
    const request = ++latest.current
    try {
      const s = await api.runner.usageSummary(f)
      if (latest.current === request) {
        setSummary(s)
        setError(null)
      }
    } catch (err) {
      if (latest.current === request) setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load(filter)
    // Live while a batch runs: a run's summary changes at every turn end; coalesce the bursts.
    let timer: ReturnType<typeof setTimeout> | null = null
    const soon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void load(filter), 1000)
    }
    const offRun = api.on('runner:run', soon)
    const offPrices = api.on('runner:prices', soon)
    return () => {
      if (timer) clearTimeout(timer)
      offRun()
      offPrices()
    }
  }, [filter, load])

  async function exportCsv() {
    setExported(null)
    try {
      const res = await api.runner.exportUsage(filter)
      if (res) setExported(res.path)
    } catch (err) {
      setError(errorText(err))
    }
  }

  const t = summary?.totals
  const perRun = t && t.runs > 0 ? t.estimatedCostUsd / t.runs : null
  const perBuilt = t && t.built > 0 ? t.estimatedCostUsd / t.built : null

  return (
    <Card withBorder radius="md" padding="md" data-testid="usage-card">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <Group gap="xs">
            <IconChartBar size={18} />
            <Title order={4}>Usage</Title>
            <Tooltip label={ESTIMATE_HINT} multiline maw={320}>
              <Badge size="sm" variant="default">
                Estimated API cost
              </Badge>
            </Tooltip>
          </Group>
          <Button size="xs" variant="default" leftSection={<IconDownload size={14} />} onClick={exportCsv} disabled={!summary?.runs.length}>
            Export CSV
          </Button>
        </Group>

        <Group gap="xs" align="flex-end">
          <SegmentedControl
            size="xs"
            value={filter.range ?? 'all'}
            onChange={(v) => setFilter((f) => ({ ...f, range: v as UsageRange }))}
            data={(Object.keys(RANGE_LABEL) as UsageRange[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
            aria-label="Date range"
          />
          <MultiSelect
            size="xs"
            w={190}
            placeholder={filter.agents?.length ? undefined : 'All agents'}
            aria-label="Agents"
            data={AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id] }))}
            value={filter.agents ?? []}
            onChange={(v) => setFilter((f) => ({ ...f, agents: v as AgentId[] }))}
            clearable
          />
          <MultiSelect
            size="xs"
            w={220}
            placeholder={filter.models?.length ? undefined : 'All models'}
            aria-label="Models"
            data={summary?.models ?? []}
            value={filter.models ?? []}
            onChange={(v) => setFilter((f) => ({ ...f, models: v }))}
            clearable
            searchable
          />
          <MultiSelect
            size="xs"
            w={200}
            placeholder={filter.statuses?.length ? undefined : 'Any status'}
            aria-label="Statuses"
            data={STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s].label }))}
            value={filter.statuses ?? []}
            onChange={(v) => setFilter((f) => ({ ...f, statuses: v as RunStatus[] }))}
            clearable
          />
          {filter.batchId && (
            <Badge
              variant="light"
              rightSection={
                <Anchor component="button" size="xs" onClick={() => setFilter((f) => ({ ...f, batchId: undefined }))}>
                  ×
                </Anchor>
              }
            >
              One batch
            </Badge>
          )}
        </Group>

        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} py={6}>
            {error}
          </Alert>
        )}
        {exported && (
          <Alert color="green" variant="light" withCloseButton onClose={() => setExported(null)} py={6}>
            Saved {exported}
          </Alert>
        )}

        {t && (
          <SimpleGrid cols={{ base: 2, md: 4 }} spacing="sm">
            <Kpi label="Runs" testId="usage-runs" value={String(t.runs)} sub={`${t.built} built a resume`} />
            <Kpi
              label="Active time"
              testId="usage-active"
              value={formatDuration(t.activeMs)}
              sub={t.runs > 0 ? `${formatDuration(t.activeMs / t.runs)} per run` : undefined}
              hint="Time the agents worked, not the time runs waited for your reply."
            />
            <Kpi
              label="Tokens"
              testId="usage-tokens"
              value={formatTokens(totalTokens(t.usage))}
              sub={`${formatTokens(t.usage.cacheReadTokens)} cached · ${formatTokens(t.usage.outputTokens)} out`}
            />
            <Kpi
              label="Est. API cost"
              testId="usage-cost"
              value={formatTotalCost({ ...t, pricedTurns: t.turns - t.unpricedTurns })}
              sub={[
                perRun !== null ? `${formatCost(perRun)}/run` : null,
                perBuilt !== null ? `${formatCost(perBuilt)}/resume` : null,
                t.failedCostUsd > 0 ? `${Math.round((t.failedCostUsd / (t.estimatedCostUsd || 1)) * 100)}% on failed runs` : null
              ]
                .filter(Boolean)
                .join(' · ')}
              hint={ESTIMATE_HINT}
            />
          </SimpleGrid>
        )}
        {t && t.unpricedTurns > 0 && (
          <Text size="xs" c="orange">
            {t.unpricedTurns} turn{t.unpricedTurns === 1 ? '' : 's'} used a model with no price: not in the cost. Add it in
            Settings → Pricing.
          </Text>
        )}
        {t && t.incompleteTurns > 0 && (
          <Text size="xs" c="dimmed">
            {t.incompleteTurns} turn{t.incompleteTurns === 1 ? '' : 's'} never ended (stopped or crashed): counted with what the
            agent had reported until then, so the totals are a lower bound.
          </Text>
        )}

        {summary && summary.byAgentModel.length > 0 && (
          <Table fz="sm" striped data-testid="usage-breakdown">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Agent</Table.Th>
                <Table.Th>Model</Table.Th>
                <Table.Th ta="right">Runs</Table.Th>
                <Table.Th ta="right">Active time</Table.Th>
                <Table.Th ta="right">Tokens</Table.Th>
                <Table.Th ta="right">Est. cost</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {summary.byAgentModel.map((g) => (
                <Table.Tr key={`${g.agent}:${g.model}`}>
                  <Table.Td>{AGENT_LABEL[g.agent]}</Table.Td>
                  <Table.Td>{g.model ?? <Text span c="dimmed" size="sm">unknown</Text>}</Table.Td>
                  <Table.Td ta="right">{g.runs}</Table.Td>
                  <Table.Td ta="right">{formatDuration(g.activeMs)}</Table.Td>
                  <Table.Td ta="right">{formatTokens(totalTokens(g.usage))}</Table.Td>
                  <Table.Td ta="right">
                    {formatTotalCost({ ...g, pricedTurns: g.turns - g.unpricedTurns })}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        {summary && <DayChart summary={summary} />}

        {summary && summary.batches.length > 0 && !filter.batchId && (
          <Stack gap={4}>
            <Text size="sm" fw={600}>
              Bulk requests
            </Text>
            <Table fz="sm" data-testid="usage-batches">
              <Table.Tbody>
                {summary.batches.slice(0, 8).map((b) => (
                  <Table.Tr key={b.batchId}>
                    <Table.Td>
                      {new Date(b.firstAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                    </Table.Td>
                    <Table.Td>{b.agents.map((a) => AGENT_LABEL[a]).join(', ')}</Table.Td>
                    <Table.Td ta="right">
                      {b.runs} run{b.runs === 1 ? '' : 's'} · {b.built} built
                    </Table.Td>
                    <Table.Td ta="right">{formatDuration(b.activeMs)}</Table.Td>
                    <Table.Td ta="right">{formatTokens(totalTokens(b.usage))} tok</Table.Td>
                    <Table.Td ta="right">
                      {formatTotalCost({ ...b, pricedTurns: b.turns - b.unpricedTurns })}
                    </Table.Td>
                    <Table.Td ta="right">
                      <Anchor component="button" size="xs" onClick={() => setFilter((f) => ({ ...f, batchId: b.batchId, range: 'all' }))}>
                        Only this
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Stack>
        )}

        {summary && summary.runs.length > 0 && (
          <Text size="xs" c="dimmed">
            Latest:{' '}
            {summary.runs.slice(0, 3).map((r, i) => (
              <span key={r.id}>
                {i > 0 && ' · '}
                <Anchor component="button" size="xs" onClick={() => onOpenRun(r.id)}>
                  {r.title}
                </Anchor>{' '}
                {formatCost(r.estimatedCostUsd)}
              </span>
            ))}
          </Text>
        )}
        {summary && summary.runs.length === 0 && (
          <Text size="sm" c="dimmed">
            No tailoring runs {filter.range && filter.range !== 'all' ? `in the last ${RANGE_LABEL[filter.range]}` : 'yet'}.
          </Text>
        )}
      </Stack>
    </Card>
  )
}
