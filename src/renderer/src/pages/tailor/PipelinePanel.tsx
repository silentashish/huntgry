import { useState } from 'react'
import { Alert, Badge, Button, Card, Group, NumberInput, Progress, Stack, Text, Title, Tooltip } from '@mantine/core'
import {
  IconBatteryOff,
  IconMoonOff,
  IconPlayerPause,
  IconPlayerPlay,
  IconPlayerStop,
  IconRobot,
  IconX
} from '@tabler/icons-react'
import { MAX_BUDGET_USD, PIPELINE_STATUS_LABEL, type PipelineState } from '@shared/pipeline-types'
import { MAX_ENQUEUE, type QueueState } from '@shared/queue-types'
import { AGENT_LABEL } from '@shared/runner-types'
import type { RunSummary } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { useNow } from '../../components/queue/usePipeline'
import { progress, statusLine } from '../jobs/pipeline-plan'
import { QueueRow } from './QueuePanel'

interface Props {
  state: PipelineState
  /** The pipeline's own items. */
  queue: QueueState
  onQueueChange(state: QueueState): void
  onPipelineChange(state: PipelineState | null): void
  onOpenRun(runId: string): void
  onReview(applicationId: string): void
  /** The runs of the items, by id, for their time · tokens · cost badge (#44). */
  runs?: ReadonlyMap<string, RunSummary>
}

/** The unattended pipeline (#31): progress, what it waits for, its controls, and its jobs. */
export function PipelinePanel({ state, queue, onQueueChange, onPipelineChange, onOpenRun, onReview, runs }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [raise, setRaise] = useState<{ maxCostUsd: number | string; maxJobs: number | string } | null>(null)
  const now = useNow(15_000)
  const meta = PIPELINE_STATUS_LABEL[state.status]
  const c = state.counts
  const active = state.status !== 'finished'

  async function act(call: () => Promise<PipelineState | null | void>) {
    setError(null)
    try {
      const next = await call()
      if (next !== undefined) onPipelineChange(next)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function queueAct(call: () => Promise<QueueState>) {
    setError(null)
    try {
      onQueueChange(await call())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const counts: { n: number; label: string; color: string }[] = [
    { n: c.queued, label: 'queued', color: 'gray' },
    { n: c.running, label: 'working', color: 'blue' },
    { n: c.unreviewed, label: 'unreviewed', color: 'yellow' },
    { n: c.needsAttention, label: 'need attention', color: 'orange' },
    { n: c.approved, label: 'approved', color: 'green' },
    { n: c.discarded, label: 'discarded', color: 'gray' },
    { n: c.needsReply, label: 'need your reply', color: 'yellow' },
    { n: c.failed, label: 'failed', color: 'red' },
    { n: c.cancelled, label: 'cancelled', color: 'gray' },
    { n: c.skipped, label: 'skipped', color: 'gray' }
  ]

  return (
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div style={{ minWidth: 0 }}>
            <Group gap="xs">
              <IconRobot size={18} />
              <Title order={4}>Unattended pipeline</Title>
              <Badge variant="light" color={meta.color}>
                {meta.label}
              </Badge>
              <Badge variant="outline" color="gray">
                {AGENT_LABEL[state.agent]}
                {state.fallbackAgent ? ` → ${AGENT_LABEL[state.fallbackAgent]}` : ''} · {state.concurrency} at a time
              </Badge>
            </Group>
            <Text size="sm" mt={4}>
              {statusLine(state, new Date(now))}
              {state.costUsd > 0 && ` · $${state.costUsd.toFixed(2)}`}
              {state.budget?.maxCostUsd !== undefined && ` of $${state.budget.maxCostUsd.toFixed(2)}`}
              {state.budget?.maxJobs !== undefined && ` · ${state.startedJobs} of ${state.budget.maxJobs} jobs`}
              {state.utilization !== undefined && ` · Claude at ${Math.round(state.utilization * 100)} % of its window`}
            </Text>
            <Group gap={6} mt={6}>
              {counts.map((k) =>
                k.n > 0 ? (
                  <Badge key={k.label} size="sm" variant="light" color={k.color}>
                    {k.n} {k.label}
                  </Badge>
                ) : null
              )}
              {state.keepAwake && (
                <Tooltip label="The Mac will not idle-sleep while the pipeline has work (the display may). Closing the lid on battery still sleeps.">
                  <Badge size="sm" variant="outline" color="teal" leftSection={<IconMoonOff size={10} />}>
                    kept awake
                  </Badge>
                </Tooltip>
              )}
              {state.onBattery && (
                <Badge size="sm" variant="outline" color="orange" leftSection={<IconBatteryOff size={10} />}>
                  on battery
                </Badge>
              )}
            </Group>
          </div>
          <Group gap="xs" align="flex-start">
            {(state.status === 'running' || state.status === 'waiting-limit') && (
              <Button size="xs" variant="light" leftSection={<IconPlayerPause size={14} />} onClick={() => act(api.pipeline.pause)}>
                Pause
              </Button>
            )}
            {state.status === 'paused' && (
              <Button size="xs" variant="light" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(() => api.pipeline.resume())}>
                Resume
              </Button>
            )}
            {state.status === 'stopped-budget' && !raise && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconPlayerPlay size={14} />}
                onClick={() => setRaise({ maxCostUsd: state.budget?.maxCostUsd ?? '', maxJobs: state.budget?.maxJobs ?? '' })}
              >
                Raise budget…
              </Button>
            )}
            {active && (
              <Button size="xs" variant="light" color="red" leftSection={<IconPlayerStop size={14} />} onClick={() => act(api.pipeline.stop)}>
                Stop
              </Button>
            )}
            {!active && (
              <Tooltip label="Hide this pipeline; its jobs stay in the queue">
                <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={() => act(() => api.pipeline.dismiss().then(() => null))}>
                  Dismiss
                </Button>
              </Tooltip>
            )}
          </Group>
        </Group>

        <Progress value={progress(state)} size="sm" color={state.status === 'finished' ? 'green' : 'blue'} animated={state.status === 'running'} />

        {raise && (
          <Group gap="sm" align="flex-end">
            <NumberInput label="Max cost ($)" w={140} min={1} max={MAX_BUDGET_USD} decimalScale={2} placeholder="No cap" value={raise.maxCostUsd} onChange={(v) => setRaise({ ...raise, maxCostUsd: v })} />
            <NumberInput label="Max jobs" w={120} min={1} max={MAX_ENQUEUE} allowDecimal={false} placeholder="No cap" value={raise.maxJobs} onChange={(v) => setRaise({ ...raise, maxJobs: v })} />
            <Button
              size="xs"
              onClick={() =>
                act(async () => {
                  const budget = {
                    ...(raise.maxCostUsd !== '' ? { maxCostUsd: Number(raise.maxCostUsd) } : {}),
                    ...(raise.maxJobs !== '' ? { maxJobs: Number(raise.maxJobs) } : {})
                  }
                  const next = await api.pipeline.resume(Object.keys(budget).length ? { budget } : {})
                  setRaise(null)
                  return next
                })
              }
            >
              Resume with this budget
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setRaise(null)}>
              Cancel
            </Button>
          </Group>
        )}

        {state.warnings.map((w) => (
          <Alert key={w} color="yellow" variant="light" py={6}>
            <Text size="sm">{w}</Text>
          </Alert>
        ))}
        {state.status === 'finished' && (c.unreviewed > 0 || c.needsAttention > 0) && (
          <Alert color="blue" variant="light" py={6}>
            <Group justify="space-between">
              <Text size="sm">
                {c.unreviewed} result{c.unreviewed === 1 ? '' : 's'} ready for your review
                {c.needsAttention > 0 ? `, ${c.needsAttention} need${c.needsAttention === 1 ? 's' : ''} attention` : ''}.
              </Text>
              <Button size="compact-xs" onClick={() => onReview('')}>
                Open Review
              </Button>
            </Group>
          </Alert>
        )}
        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} py={6}>
            {error}
          </Alert>
        )}

        <Stack gap={6}>
          {queue.items.map((item) => (
            <QueueRow
              key={item.id}
              item={item}
              run={item.runId ? runs?.get(item.runId) : undefined}
              onAct={queueAct}
              onOpenRun={onOpenRun}
              onReview={onReview}
            />
          ))}
        </Stack>
      </Stack>
    </Card>
  )
}
