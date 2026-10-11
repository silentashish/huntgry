import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Anchor,
  Box,
  Button,
  Card,
  Collapse,
  Group,
  MultiSelect,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Tooltip
} from '@mantine/core'
import { IconChartBar, IconChevronDown, IconChevronUp, IconDownload, IconInfoCircle } from '@tabler/icons-react'
import { totalTokens } from '@shared/pricing'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type RunStatus } from '@shared/runner-types'
import type { UsageFilter, UsageRange, UsageSummary } from '@shared/usage-types'
import { api, errorText } from '../../api'
import { formatCost, formatDuration, formatTokens, formatTotalCost } from '../../components/usage/format'
import { ESTIMATE_HINT } from '../../components/usage/RunMetrics'
import { KpiTile, MonoLabel, StatusPill } from '../../components/ui'
import { STATUS_LABEL } from '../tailor/status'
import classes from './dashboard.module.css'
import { dayBars, shortDate } from './summary'

const RANGE_LABEL: Record<UsageRange, string> = { '7d': '7 days', '30d': '30 days', all: 'All time' }
const STATUSES: RunStatus[] = ['finished', 'failed', 'stopped', 'waiting', 'running']
const ALL_AGENTS = 'all'

/** A usage KPI tile; the figure carries the test id the e2e page object reads (#44). */
function Kpi({ label, value, sub, testId, hint }: { label: string; value: string; sub?: string; testId: string; hint?: string }) {
  const tile = <KpiTile label={label} value={<span data-testid={testId}>{value}</span>} sub={sub} />
  return hint ? (
    <Tooltip label={hint} multiline maw={300}>
      <div>{tile}</div>
    </Tooltip>
  ) : (
    tile
  )
}

/** Estimated cost (or tokens) per calendar day of the range: the last week in Ember, today solid. */
function DayChart({ summary, range }: { summary: UsageSummary; range: UsageRange | undefined }) {
  const [metric, setMetric] = useState<'cost' | 'tokens'>('cost')
  const bars = useMemo(() => dayBars(summary.byDay, range), [summary.byDay, range])
  if (bars.length === 0) return null
  const value = (d: (typeof bars)[number]) => (metric === 'cost' ? d.costUsd : d.tokens)
  const max = Math.max(...bars.map(value), 0) || 1
  const [y1, m1, d1] = bars[0].day.split('-').map(Number)
  const [y2, m2, d2] = bars[bars.length - 1].day.split('-').map(Number)
  return (
    <div className={classes.chart}>
      <div className={classes.bars} data-testid="usage-chart">
        {bars.map((d) => (
          <Tooltip
            key={d.day}
            label={`${d.day}: ${formatCost(d.costUsd)} · ${formatTokens(d.tokens)} tokens · ${formatDuration(d.activeMs)}`}
          >
            <Box
              className={classes.bar}
              data-recent={d.recent || undefined}
              data-today={d.today || undefined}
              h={`${Math.max(4, (value(d) / max) * 100)}%`}
              aria-label={`${d.day} ${metric === 'cost' ? formatCost(d.costUsd) : formatTokens(d.tokens)}`}
            />
          </Tooltip>
        ))}
      </div>
      <div className={classes.chartAxis}>
        <MonoLabel size="xs">{shortDate(new Date(y1, m1 - 1, d1).toISOString())}</MonoLabel>
        <button
          type="button"
          className={classes.axisToggle}
          onClick={() => setMetric((m) => (m === 'cost' ? 'tokens' : 'cost'))}
          title={metric === 'cost' ? 'Show tokens per day' : 'Show estimated cost per day'}
        >
          <MonoLabel size="xs" tone="inherit">
            {metric === 'cost' ? 'Est. cost per day' : 'Tokens per day'}
          </MonoLabel>
        </button>
        <MonoLabel size="xs">{shortDate(new Date(y2, m2 - 1, d2).toISOString())}</MonoLabel>
      </div>
    </div>
  )
}

/**
 * Totals across tailoring runs (#44): run time, tokens and estimated API cost, filterable by date,
 * agent, model and status, split by agent × model and per "Tailor all" batch. Every number comes
 * from the main process (`runner:usage-summary`), summed from the runs' per-turn metrics.
 * `hideWhenEmpty`: render nothing while the workspace has no runs at all (the first-hunt page).
 */
export function UsageCard({ onOpenRun, hideWhenEmpty = false }: { onOpenRun(runId: string): void; hideWhenEmpty?: boolean }) {
  const [filter, setFilter] = useState<UsageFilter>({ range: '30d' })
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [details, setDetails] = useState(false)
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

  // `models` lists every model of the workspace's runs whatever the filter: empty means no run at all.
  if (hideWhenEmpty && (!summary || (summary.models.length === 0 && summary.runs.length === 0 && !filter.agents?.length))) return null

  const t = summary?.totals
  const perRun = t && t.runs > 0 ? t.estimatedCostUsd / t.runs : null
  const perBuilt = t && t.built > 0 ? t.estimatedCostUsd / t.built : null
  const allTokens = t ? totalTokens(t.usage) : 0
  const cachedShare = t && allTokens > 0 ? Math.round((t.usage.cacheReadTokens / allTokens) * 100) : null
  const agent = filter.agents?.length === 1 ? filter.agents[0] : ALL_AGENTS
  const hasDetails = !!summary && (summary.byAgentModel.length > 0 || summary.batches.length > 0 || summary.runs.length > 0 || summary.models.length > 0)

  return (
    <Card withBorder radius="xl" padding="lg" data-testid="usage-card">
      <Stack gap="md">
        <div className={classes.usageHeader}>
          <IconChartBar size={18} color="var(--hg-icon-default)" aria-hidden />
          <h3 className={classes.usageTitle}>Usage</h3>
          <Tooltip label={ESTIMATE_HINT} multiline maw={320}>
            <span style={{ display: 'inline-flex' }}>
              <StatusPill variant="outline" leftSection={<IconInfoCircle size={12} />}>
                Estimated API cost
              </StatusPill>
            </span>
          </Tooltip>
          <SegmentedControl
            size="xs"
            value={filter.range ?? 'all'}
            onChange={(v) => setFilter((f) => ({ ...f, range: v as UsageRange }))}
            data={(Object.keys(RANGE_LABEL) as UsageRange[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
            aria-label="Date range"
          />
          <Select
            w={150}
            aria-label="Agents"
            data={[{ value: ALL_AGENTS, label: 'All agents' }, ...AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id] }))]}
            value={filter.agents && filter.agents.length > 1 ? null : agent}
            placeholder={filter.agents && filter.agents.length > 1 ? `${filter.agents.length} agents` : undefined}
            allowDeselect={false}
            onChange={(v) => setFilter((f) => ({ ...f, agents: !v || v === ALL_AGENTS ? undefined : [v as AgentId] }))}
          />
          <Button size="xs" variant="subtle" leftSection={<IconDownload size={14} />} onClick={exportCsv} disabled={!summary?.runs.length}>
            Export CSV
          </Button>
          {filter.batchId && (
            <StatusPill tone="accent">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                One batch
                <Anchor component="button" size="xs" aria-label="Show every batch" onClick={() => setFilter((f) => ({ ...f, batchId: undefined }))}>
                  ×
                </Anchor>
              </span>
            </StatusPill>
          )}
          {hasDetails && (
            <Button
              size="xs"
              variant="subtle"
              ml="auto"
              rightSection={details ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
              onClick={() => setDetails((d) => !d)}
              aria-expanded={details}
            >
              Breakdown
            </Button>
          )}
        </div>

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
          <div className={classes.usageBody}>
            <div className={classes.usageKpis}>
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
                value={formatTokens(allTokens)}
                sub={`${cachedShare !== null ? `${cachedShare}% cached` : `${formatTokens(t.usage.cacheReadTokens)} cached`} · ${formatTokens(t.usage.outputTokens)} out`}
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
            </div>
            {summary && <DayChart summary={summary} range={filter.range} />}
          </div>
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
        {summary && summary.runs.length === 0 && (
          <Text size="sm" c="dimmed">
            No tailoring runs {filter.range && filter.range !== 'all' ? `in the last ${RANGE_LABEL[filter.range]}` : 'yet'}.
          </Text>
        )}

        {summary && (
          <Collapse expanded={details}>
            <Details summary={summary} filter={filter} setFilter={setFilter} onOpenRun={onOpenRun} />
          </Collapse>
        )}
      </Stack>
    </Card>
  )
}

/** The rest of #44's card behind "Breakdown": model and status filters, agent × model, bulk requests, latest runs. */
function Details({
  summary,
  filter,
  setFilter,
  onOpenRun
}: {
  summary: UsageSummary
  filter: UsageFilter
  setFilter(update: (f: UsageFilter) => UsageFilter): void
  onOpenRun(runId: string): void
}): ReactNode {
  return (
    <Stack gap="md" pt="xs">
      <Group gap="xs" align="flex-end">
        <MultiSelect
          size="xs"
          w={190}
          placeholder={filter.agents?.length ? undefined : 'All agents'}
          aria-label="Agents (several)"
          data={AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id] }))}
          value={filter.agents ?? []}
          onChange={(v) => setFilter((f) => ({ ...f, agents: v.length ? (v as AgentId[]) : undefined }))}
          clearable
        />
        <MultiSelect
          size="xs"
          w={220}
          placeholder={filter.models?.length ? undefined : 'All models'}
          aria-label="Models"
          data={summary.models}
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
      </Group>

      {summary.byAgentModel.length > 0 && (
        <Table fz="sm" data-testid="usage-breakdown">
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
          <Table.Tbody ff="monospace">
            {summary.byAgentModel.map((g) => (
              <Table.Tr key={`${g.agent}:${g.model}`}>
                <Table.Td ff="var(--hg-font-ui)">{AGENT_LABEL[g.agent]}</Table.Td>
                <Table.Td>
                  {g.model ?? (
                    <Text span c="dimmed" size="sm">
                      unknown
                    </Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">{g.runs}</Table.Td>
                <Table.Td ta="right">{formatDuration(g.activeMs)}</Table.Td>
                <Table.Td ta="right">{formatTokens(totalTokens(g.usage))}</Table.Td>
                <Table.Td ta="right">{formatTotalCost({ ...g, pricedTurns: g.turns - g.unpricedTurns })}</Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      {summary.batches.length > 0 && !filter.batchId && (
        <Stack gap={4}>
          <MonoLabel component="div">Bulk requests</MonoLabel>
          <Table fz="sm" data-testid="usage-batches">
            <Table.Tbody>
              {summary.batches.slice(0, 8).map((b) => (
                <Table.Tr key={b.batchId}>
                  <Table.Td>{new Date(b.firstAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</Table.Td>
                  <Table.Td>{b.agents.map((a) => AGENT_LABEL[a]).join(', ')}</Table.Td>
                  <Table.Td ta="right">
                    {b.runs} run{b.runs === 1 ? '' : 's'} · {b.built} built
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatDuration(b.activeMs)}
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
                    {formatTokens(totalTokens(b.usage))} tok
                  </Table.Td>
                  <Table.Td ta="right" ff="monospace">
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

      {summary.runs.length > 0 && (
        <Text size="xs" c="dimmed">
          Latest:{' '}
          {summary.runs.slice(0, 3).map((r, i) => (
            <span key={r.id}>
              {i > 0 && ' · '}
              <Anchor component="button" size="xs" onClick={() => onOpenRun(r.id)}>
                {r.title}
              </Anchor>{' '}
              <Text span size="xs" ff="monospace">
                {formatCost(r.estimatedCostUsd)}
              </Text>
            </span>
          ))}
        </Text>
      )}
    </Stack>
  )
}
