import { useState } from 'react'
import { ActionIcon, Alert, Badge, Button, Card, Group, Select, Stack, Text, Title, Tooltip } from '@mantine/core'
import { IconPlayerPause, IconPlayerPlay, IconRefresh, IconTrash, IconX } from '@tabler/icons-react'
import { MAX_CONCURRENCY, type QueueItemStatus, type QueueState } from '@shared/queue-types'
import { api, errorText } from '../../api'
import { QUEUE_STATUS_LABEL } from './status'

interface Props {
  queue: QueueState
  onChange(state: QueueState): void
  onOpenRun(runId: string): void
}

const COUNTED: QueueItemStatus[] = ['queued', 'running', 'needs-reply', 'done', 'failed']

/** The bulk tailoring queue: one row per job, with its run's status and what can be done with it. */
export function QueuePanel({ queue, onChange, onOpenRun }: Props) {
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
            <Title order={4}>Tailoring queue</Title>
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
          {queue.items.map((item) => {
            const label = QUEUE_STATUS_LABEL[item.status]
            const active = ['queued', 'preparing', 'running', 'needs-reply'].includes(item.status)
            return (
              <Group key={item.id} justify="space-between" wrap="nowrap" gap="sm">
                <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                  <Group gap={6} wrap="nowrap">
                    <Badge size="sm" variant="light" color={label.color} style={{ flexShrink: 0 }}>
                      {label.label}
                    </Badge>
                    {item.built && (
                      <Badge size="sm" variant="light" color="green" style={{ flexShrink: 0 }}>
                        Resume built
                      </Badge>
                    )}
                    <Text size="sm" fw={500} truncate>
                      {item.title}
                    </Text>
                  </Group>
                  {item.error && (
                    <Text size="xs" c={item.status === 'failed' ? 'red' : 'dimmed'} mt={2}>
                      {item.error}
                    </Text>
                  )}
                </Stack>
                <Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
                  {item.runId && (
                    <Button size="compact-xs" variant={item.status === 'needs-reply' ? 'filled' : 'subtle'} onClick={() => onOpenRun(item.runId!)}>
                      {item.status === 'needs-reply' ? 'Reply' : 'Open run'}
                    </Button>
                  )}
                  {active && (
                    <Tooltip label="Cancel">
                      <ActionIcon size="sm" variant="subtle" color="red" aria-label="Cancel" onClick={() => act(() => api.queue.cancel(item.id))}>
                        <IconX size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {(item.status === 'failed' || item.status === 'cancelled') && (
                    <Tooltip label="Retry">
                      <ActionIcon size="sm" variant="subtle" aria-label="Retry" onClick={() => act(() => api.queue.retry(item.id))}>
                        <IconRefresh size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                  {item.status !== 'preparing' && item.status !== 'running' && (
                    <Tooltip label="Remove from the queue">
                      <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Remove" onClick={() => act(() => api.queue.remove(item.id))}>
                        <IconTrash size={14} />
                      </ActionIcon>
                    </Tooltip>
                  )}
                </Group>
              </Group>
            )
          })}
        </Stack>
      </Stack>
    </Card>
  )
}
