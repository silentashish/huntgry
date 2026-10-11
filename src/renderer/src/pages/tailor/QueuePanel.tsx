import { useState } from 'react'
import { ActionIcon, Alert, Button, Select, Tooltip } from '@mantine/core'
import { IconPlayerPause, IconPlayerPlay, IconRefresh, IconSend, IconTrash, IconX } from '@tabler/icons-react'
import { MAX_CONCURRENCY, type QueueItem, type QueueItemStatus, type QueueState } from '@shared/queue-types'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type RunSummary } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { useNow } from '../../components/queue/usePipeline'
import { SectionCard, StatusPill } from '../../components/ui'
import { runBadge } from '../../components/usage/format'
import { AgentPill, Chip, MonoXs } from './parts'
import { awaitsReview, FAILURE_LABEL, OUTCOME_LABEL, QUEUE_STATUS_LABEL } from './status'
import classes from './tailor.module.css'

interface Props {
  queue: QueueState
  onChange(state: QueueState): void
  onOpenRun(runId: string): void
  /** Open an unattended result on the Review page. */
  onReview?(applicationId: string): void
  /** Title of the card ("Tailoring queue" by default). */
  title?: string
  /** The runs of the items, by id, for their time · tokens · cost badge (#44). */
  runs?: ReadonlyMap<string, RunSummary>
}

const COUNTED: QueueItemStatus[] = ['queued', 'running', 'needs-reply', 'done', 'failed']

/** The bulk tailoring queue: one row per job, with its run's status and what can be done with it. */
export function QueuePanel({ queue, onChange, onOpenRun, onReview, title = 'Tailoring queue', runs }: Props) {
  const [error, setError] = useState<string | null>(null)

  async function act(call: () => Promise<QueueState>) {
    setError(null)
    try {
      onChange(await call())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const count = (st: QueueItemStatus) =>
    queue.items.filter((i) => i.status === st || (st === 'running' && i.status === 'preparing')).length
  const pending = queue.items.some((i) => i.status === 'queued')
  const cancellable = queue.items.some((i) => ['queued', 'preparing', 'running', 'needs-reply'].includes(i.status))
  const finished = queue.items.some((i) => i.status === 'done' || i.status === 'cancelled')

  return (
    <SectionCard
      title={title}
      titleOrder={4}
      padding={18}
      badge={
        <span className={classes.pills}>
          {COUNTED.map((st) =>
            count(st) > 0 ? (
              <StatusPill key={st} tone={QUEUE_STATUS_LABEL[st].tone}>
                {count(st)} {QUEUE_STATUS_LABEL[st].label.toLowerCase()}
              </StatusPill>
            ) : null
          )}
        </span>
      }
      actions={
        <>
          <Select
            w={130}
            aria-label="Runs at once"
            allowDeselect={false}
            value={String(queue.concurrency)}
            onChange={(v) => v && void act(() => api.queue.setConcurrency(Number(v)))}
            data={Array.from({ length: MAX_CONCURRENCY }, (_, i) => ({
              value: String(i + 1),
              label: `${i + 1} at a time`
            }))}
          />
          <Button
            size="xs"
            variant="subtle"
            leftSection={queue.paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
            onClick={() => act(() => api.queue.setPaused(!queue.paused))}
          >
            {queue.paused ? 'Resume' : 'Pause'}
          </Button>
          <Button size="xs" variant="subtle" disabled={!finished} onClick={() => act(api.queue.clearFinished)}>
            Clear finished
          </Button>
          <Button size="xs" variant="light" color="danger" disabled={!cancellable} onClick={() => act(api.queue.cancelAll)}>
            Cancel all
          </Button>
        </>
      }
    >
      <div className={classes.panelBody}>
        {queue.items.length === 0 && <p className={classes.queueEmpty}>Empty. Tick jobs on the Jobs page and press Tailor all.</p>}
        {queue.paused && pending && (
          <Alert color="warning" py={8}>
            Paused: queued jobs start when you press Resume.
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
                onAct={act}
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

interface RowProps {
  item: QueueItem
  /** The item's run, when known: its badge shows time · tokens · est. cost. */
  run?: RunSummary
  onAct(call: () => Promise<QueueState>): void
  onOpenRun(runId: string): void
  onReview?(applicationId: string): void
}

/** `starts in 5 min`, `starts in 40 s`, `starts in 2 h`. */
function startsInText(seconds: number): string {
  return seconds >= 3600 ? `starts in ${Math.round(seconds / 3600)} h` : seconds >= 120 ? `starts in ${Math.round(seconds / 60)} min` : `starts in ${seconds} s`
}

/** One queue item (Figma Queue row): status, agent, title, readouts, chips, notes and its actions. Shared with the pipeline panel. */
export function QueueRow({ item, run, onAct, onOpenRun, onReview }: RowProps) {
  const label = QUEUE_STATUS_LABEL[item.status]
  const active = ['queued', 'preparing', 'running', 'needs-reply'].includes(item.status)
  const live = item.status === 'running' || item.status === 'preparing' || item.status === 'needs-reply' || item.status === 'queued'
  const now = useNow(1000)
  const startsIn = item.status === 'queued' && item.notBefore ? Math.max(0, Math.round((Date.parse(item.notBefore) - now) / 1000)) : null
  const chips: { text: string; tone?: 'warning' }[] = []
  if (item.unattended) {
    if (item.retries) chips.push({ text: `retry ${item.retries}/2`, tone: 'warning' })
    else if (item.attempts > 1) chips.push({ text: `attempt ${item.attempts}` })
    if (item.lastFailure && item.status !== 'done') chips.push({ text: FAILURE_LABEL[item.lastFailure] ?? item.lastFailure, tone: 'warning' })
    if (item.interruptedOnce && active) chips.push({ text: 'requeued after a restart' })
    if (item.nudged && item.status === 'needs-reply') chips.push({ text: 'nudged once' })
  }
  const badge = run ? runBadge(run) : null
  const editableAgent = (item.status === 'queued' && !item.runId) || item.status === 'failed' || item.status === 'cancelled'
  return (
    <div className={classes.queueRow}>
      <div className={classes.queueRowPills}>
        <StatusPill tone={label.tone} dot={live}>
          {label.label}
        </StatusPill>
        {/* The agent can change until the job starts (a retry starts a new run): then it is a select, not a pill. */}
        {!editableAgent && <AgentPill agent={item.agent} />}
        {item.status === 'done' && item.outcome ? (
          <StatusPill tone={OUTCOME_LABEL[item.outcome].tone}>{OUTCOME_LABEL[item.outcome].label}</StatusPill>
        ) : (
          item.built && <StatusPill tone="success">Resume built</StatusPill>
        )}
      </div>
      <div className={classes.queueRowBody}>
        <span className={classes.queueRowTitle} title={item.title}>
          {item.title}
        </span>
        {(badge || (startsIn !== null && startsIn > 0) || chips.length > 0) && (
          <div className={classes.queueRowMeta}>
            {badge && <MonoXs testId="queue-run-usage">{badge}</MonoXs>}
            {startsIn !== null && startsIn > 0 && <MonoXs>{startsInText(startsIn)}</MonoXs>}
            {chips.map((c) => (
              <Chip key={c.text} tone={c.tone}>
                {c.text}
              </Chip>
            ))}
          </div>
        )}
        {item.pendingReply && (
          <span className={classes.queueRowNote} data-tone="warning">
            Your reply is held until one of the working runs finishes its turn.
          </span>
        )}
        {item.error && (
          <span className={classes.queueRowNote} data-tone={item.status === 'failed' ? 'danger' : undefined}>
            {item.error}
          </span>
        )}
      </div>
      <div className={classes.queueRowActions}>
        {editableAgent && (
          <Select
            size="xs"
            w={110}
            aria-label={`Agent for ${item.title}`}
            allowDeselect={false}
            value={item.agent}
            onChange={(v) => v && v !== item.agent && void onAct(() => api.queue.setAgent(item.id, v as AgentId))}
            data={AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id] }))}
            mr={6}
          />
        )}
        {item.status === 'done' && item.applicationId && awaitsReview(item.outcome) && onReview && (
          <Button
            size="xs"
            variant={item.outcome === 'needs-attention' ? 'filled' : 'default'}
            onClick={() => onReview(item.applicationId!)}
          >
            Review
          </Button>
        )}
        {item.runId &&
          (item.status === 'needs-reply' ? (
            <Button size="xs" variant="filled" leftSection={<IconSend size={14} />} onClick={() => onOpenRun(item.runId!)}>
              Reply
            </Button>
          ) : (
            <Button size="xs" variant="default" onClick={() => onOpenRun(item.runId!)}>
              Open run
            </Button>
          ))}
        {active && (
          <Tooltip label="Cancel">
            <ActionIcon variant="subtle" aria-label="Cancel" onClick={() => onAct(() => api.queue.cancel(item.id))}>
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Tooltip label="Retry">
            <ActionIcon variant="subtle" aria-label="Retry" onClick={() => onAct(() => api.queue.retry(item.id))}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {item.status !== 'preparing' && item.status !== 'running' && (
          <Tooltip label="Remove from the queue">
            <ActionIcon variant="subtle" aria-label="Remove" onClick={() => onAct(() => api.queue.remove(item.id))}>
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
