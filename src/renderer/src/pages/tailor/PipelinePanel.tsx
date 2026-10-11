import { useState } from 'react'
import { Alert, Button, Group, NumberInput, Text, Tooltip } from '@mantine/core'
import { IconBatteryOff, IconCpu, IconMoonOff, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconX } from '@tabler/icons-react'
import { MAX_BUDGET_USD, PIPELINE_STATUS_LABEL, type PipelineState } from '@shared/pipeline-types'
import { MAX_ENQUEUE, type QueueState } from '@shared/queue-types'
import { AGENT_LABEL } from '@shared/runner-types'
import type { RunSummary } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { useNow } from '../../components/queue/usePipeline'
import { ProgressBar, SectionCard, StatusPill, type UiTone } from '../../components/ui'
import { progress, statusLine } from '../jobs/pipeline-plan'
import { QueueRow } from './QueuePanel'
import { PIPELINE_TONE } from './status'
import classes from './tailor.module.css'

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

  const counts: { n: number; label: string; tone: UiTone }[] = [
    { n: c.queued, label: 'queued', tone: 'neutral' },
    { n: c.running, label: 'working', tone: 'info' },
    { n: c.unreviewed, label: 'unreviewed', tone: 'warning' },
    { n: c.needsAttention, label: 'need attention', tone: 'accent' },
    { n: c.approved, label: 'approved', tone: 'success' },
    { n: c.discarded, label: 'discarded', tone: 'neutral' },
    { n: c.needsReply, label: 'need your reply', tone: 'warning' },
    { n: c.failed, label: 'failed', tone: 'danger' },
    { n: c.cancelled, label: 'cancelled', tone: 'neutral' },
    { n: c.skipped, label: 'skipped', tone: 'neutral' }
  ]

  const line = [
    statusLine(state, new Date(now)),
    state.budget?.maxCostUsd !== undefined
      ? `$${state.costUsd.toFixed(2)} of $${state.budget.maxCostUsd.toFixed(2)}`
      : state.costUsd > 0
        ? `$${state.costUsd.toFixed(2)}`
        : null,
    state.budget?.maxJobs !== undefined ? `${state.startedJobs} of ${state.budget.maxJobs} jobs` : null,
    state.utilization !== undefined ? `Claude at ${Math.round(state.utilization * 100)} % of its window` : null
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <SectionCard
      title="Unattended pipeline"
      titleOrder={4}
      icon={<IconCpu size={18} />}
      accent={state.status === 'running' ? 'trail' : undefined}
      padding={18}
      badge={
        <>
          <StatusPill tone={PIPELINE_TONE[state.status]} dot={state.status === 'running'}>
            {meta.label}
          </StatusPill>
          <StatusPill size="md">
            {AGENT_LABEL[state.agent]}
            {state.fallbackAgent ? ` → ${AGENT_LABEL[state.fallbackAgent]}` : ''} · {state.concurrency} at a time
          </StatusPill>
        </>
      }
      actions={
        <>
          {state.keepAwake && (
            <Tooltip label="The Mac will not idle-sleep while the pipeline has work (the display may). Closing the lid on battery still sleeps.">
              <span style={{ display: 'inline-flex' }}>
                <StatusPill size="md" variant="outline" leftSection={<IconMoonOff size={12} />}>
                  kept awake
                </StatusPill>
              </span>
            </Tooltip>
          )}
          {state.onBattery && (
            <StatusPill size="md" tone="warning" variant="outline" leftSection={<IconBatteryOff size={12} />}>
              on battery
            </StatusPill>
          )}
          {(state.status === 'running' || state.status === 'waiting-limit') && (
            <Button size="xs" variant="default" leftSection={<IconPlayerPause size={14} />} onClick={() => act(api.pipeline.pause)}>
              Pause
            </Button>
          )}
          {state.status === 'paused' && (
            <Button size="xs" variant="default" leftSection={<IconPlayerPlay size={14} />} onClick={() => act(() => api.pipeline.resume())}>
              Resume
            </Button>
          )}
          {state.status === 'stopped-budget' && !raise && (
            <Button
              size="xs"
              variant="subtle"
              leftSection={<IconPlayerPlay size={14} />}
              onClick={() => setRaise({ maxCostUsd: state.budget?.maxCostUsd ?? '', maxJobs: state.budget?.maxJobs ?? '' })}
            >
              Raise budget…
            </Button>
          )}
          {active && (
            <Button size="xs" variant="light" color="danger" leftSection={<IconPlayerStop size={14} />} onClick={() => act(api.pipeline.stop)}>
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
        </>
      }
    >
      <div className={classes.panelBody}>
        <span className={classes.statusLine}>{line}</span>
        <ProgressBar
          value={progress(state)}
          size="md"
          tone={state.status === 'finished' ? 'success' : 'trail'}
          aria-label={`${progress(state)} % of the pipeline's jobs done`}
        />
        <div className={classes.pills}>
          {counts.map((k) =>
            k.n > 0 ? (
              <StatusPill key={k.label} tone={k.tone}>
                {k.n} {k.label}
              </StatusPill>
            ) : null
          )}
        </div>

        {raise && (
          <div className={classes.raiseRow}>
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
          </div>
        )}

        {state.warnings.map((w) => (
          <Alert key={w} color="warning" py={8}>
            <Text size="sm">{w}</Text>
          </Alert>
        ))}
        {state.status === 'finished' && (c.unreviewed > 0 || c.needsAttention > 0) && (
          <Alert color="info" py={8}>
            <Group justify="space-between">
              <Text size="sm">
                {c.unreviewed} result{c.unreviewed === 1 ? '' : 's'} ready for your review
                {c.needsAttention > 0 ? `, ${c.needsAttention} need${c.needsAttention === 1 ? 's' : ''} attention` : ''}.
              </Text>
              <Button size="xs" onClick={() => onReview('')}>
                Open Review
              </Button>
            </Group>
          </Alert>
        )}
        {error && (
          <Alert color="danger" withCloseButton onClose={() => setError(null)} py={8}>
            {error}
          </Alert>
        )}

        {queue.items.length > 0 && (
          <div className={classes.queueRows}>
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
          </div>
        )}
      </div>
    </SectionCard>
  )
}
