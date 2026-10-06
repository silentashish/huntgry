import { useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Card, Group, Select, Stack, Text, Title, Tooltip } from '@mantine/core'
import { IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash, IconX } from '@tabler/icons-react'
import { MAX_CONCURRENCY, type QueueItem, type QueueItemStatus, type QueueState } from '@shared/queue-types'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type RunSummary } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { useNow } from '../../components/queue/usePipeline'
import { runBadge } from '../../components/usage/format'
import { AGENT_COLOR, awaitsReview, FAILURE_LABEL, OUTCOME_LABEL, QUEUE_STATUS_LABEL } from './status'

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
    <Card withBorder radius="md" padding="md">
      <Stack gap="sm">
        <Group justify="space-between" align="flex-start">
          <div>
            <Title order={4}>{title}</Title>
            <Group gap={6} mt={4}>
              {COUNTED.map((st) =>
                count(st) > 0 ? (
                  <Badge key={st} size="sm" variant="light" color={QUEUE_STATUS_LABEL[st].color}>
                    {count(st)} {QUEUE_STATUS_LABEL[st].label.toLowerCase()}
                  </Badge>
                ) : null
              )}
              {queue.items.length === 0 && (
                <Text size="sm" c="dimmed">
                  Empty. Tick jobs on the Jobs page and press Tailor all.
                </Text>
              )}
            </Group>
          </div>
          <Group gap="xs" align="flex-end">
            <Select
              size="xs"
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
              variant="light"
              leftSection={queue.paused ? <IconPlayerPlay size={14} /> : <IconPlayerPause size={14} />}
              onClick={() => act(() => api.queue.setPaused(!queue.paused))}
            >
              {queue.paused ? 'Resume' : 'Pause'}
            </Button>
            <Button size="xs" variant="light" color="red" disabled={!cancellable} onClick={() => act(api.queue.cancelAll)}>
              Cancel all
            </Button>
            <Button size="xs" variant="default" disabled={!finished} onClick={() => act(api.queue.clearFinished)}>
              Clear finished
            </Button>
          </Group>
        </Group>

        {queue.paused && pending && (
          <Alert color="yellow" variant="light" py={6}>
            <Text size="sm">Paused: queued jobs start when you press Resume.</Text>
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
              onAct={act}
              onOpenRun={onOpenRun}
              onReview={onReview}
            />
          ))}
        </Stack>
      </Stack>
    </Card>
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

/** One queue item: status, agent, result badges, error text and its actions. Shared with the pipeline panel. */
export function QueueRow({ item, run, onAct, onOpenRun, onReview }: RowProps) {
  const label = QUEUE_STATUS_LABEL[item.status]
  const active = ['queued', 'preparing', 'running', 'needs-reply'].includes(item.status)
  const now = useNow(1000)
  const startsIn = item.status === 'queued' && item.notBefore ? Math.max(0, Math.round((Date.parse(item.notBefore) - now) / 1000)) : null
  const chips: string[] = []
  if (item.unattended) {
    if (item.retries) chips.push(`retry ${item.retries}/2`)
    else if (item.attempts > 1) chips.push(`attempt ${item.attempts}`)
    if (item.lastFailure && item.status !== 'done') chips.push(FAILURE_LABEL[item.lastFailure] ?? item.lastFailure)
    if (startsIn !== null && startsIn > 0) chips.push(startsIn >= 3600 ? `starts in ${Math.round(startsIn / 3600)} h` : startsIn >= 120 ? `starts in ${Math.round(startsIn / 60)} min` : `starts in ${startsIn} s`)
    if (item.interruptedOnce && active) chips.push('requeued after a restart')
    if (item.nudged && item.status === 'needs-reply') chips.push('nudged once')
  }
  return (
    <Group justify="space-between" wrap="nowrap" gap="sm">
      <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
        <Group gap={6} wrap="nowrap">
          <Badge size="sm" variant="light" color={label.color} style={{ flexShrink: 0 }}>
            {label.label}
          </Badge>
          {/* The agent can change until the job starts (a retry starts a new run). */}
          {(item.status === 'queued' && !item.runId) || item.status === 'failed' || item.status === 'cancelled' ? (
            <Select
              size="xs"
              w={120}
              aria-label={`Agent for ${item.title}`}
              allowDeselect={false}
              value={item.agent}
              onChange={(v) => v && v !== item.agent && void onAct(() => api.queue.setAgent(item.id, v as AgentId))}
              data={AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id] }))}
              style={{ flexShrink: 0 }}
            />
          ) : (
            <Badge size="sm" variant="outline" color={AGENT_COLOR[item.agent]} style={{ flexShrink: 0 }}>
              {AGENT_LABEL[item.agent]}
            </Badge>
          )}
          {item.status === 'done' && item.outcome ? (
            <Badge size="sm" variant="light" color={OUTCOME_LABEL[item.outcome].color} style={{ flexShrink: 0 }}>
              {OUTCOME_LABEL[item.outcome].label}
            </Badge>
          ) : (
            item.built && (
              <Badge size="sm" variant="light" color="green" style={{ flexShrink: 0 }}>
                Resume built
              </Badge>
            )
          )}
          {chips.map((c) => (
            <Badge key={c} size="xs" variant="default" color="gray" style={{ flexShrink: 0 }}>
              {c}
            </Badge>
          ))}
          <Text size="sm" fw={500} truncate>
            {item.title}
          </Text>
          {run && runBadge(run) && (
            <Text size="xs" c="dimmed" style={{ flexShrink: 0 }} data-testid="queue-run-usage">
              {runBadge(run)}
            </Text>
          )}
        </Group>
        {item.pendingReply && (
          <Text size="xs" c="dimmed" mt={2}>
            Your reply is held until one of the working runs finishes its turn.
          </Text>
        )}
        {item.error && (
          <Text size="xs" c={item.status === 'failed' ? 'red' : 'dimmed'} mt={2}>
            {item.error}
          </Text>
        )}
      </Stack>
      <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
        {item.status === 'done' && item.applicationId && awaitsReview(item.outcome) && onReview && (
          <Button size="compact-xs" variant={item.outcome === 'needs-attention' ? 'filled' : 'light'} onClick={() => onReview(item.applicationId!)}>
            Review
          </Button>
        )}
        {item.runId && (
          <Button size="compact-xs" variant={item.status === 'needs-reply' ? 'filled' : 'subtle'} onClick={() => onOpenRun(item.runId!)}>
            {item.status === 'needs-reply' ? 'Reply' : 'Open run'}
          </Button>
        )}
        {active && (
          <Tooltip label="Cancel">
            <ActionIcon size="sm" variant="subtle" color="red" aria-label="Cancel" onClick={() => onAct(() => api.queue.cancel(item.id))}>
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {(item.status === 'failed' || item.status === 'cancelled') && (
          <Tooltip label="Retry">
            <ActionIcon size="sm" variant="subtle" aria-label="Retry" onClick={() => onAct(() => api.queue.retry(item.id))}>
              <IconRefresh size={14} />
            </ActionIcon>
          </Tooltip>
        )}
        {item.status !== 'preparing' && item.status !== 'running' && (
          <Tooltip label="Remove from the queue">
            <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Remove" onClick={() => onAct(() => api.queue.remove(item.id))}>
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
    </Group>
  )
}
