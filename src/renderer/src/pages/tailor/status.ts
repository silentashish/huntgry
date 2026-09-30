import type { QueueItemStatus } from '@shared/queue-types'
import type { RunStatus } from '@shared/runner-types'

export const STATUS_LABEL: Record<RunStatus, { label: string; color: string }> = {
  running: { label: 'Claude is working', color: 'blue' },
  waiting: { label: 'Waiting for you', color: 'yellow' },
  finished: { label: 'Finished', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  stopped: { label: 'Stopped', color: 'gray' }
}

export const QUEUE_STATUS_LABEL: Record<QueueItemStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: 'gray' },
  preparing: { label: 'Starting', color: 'cyan' },
  running: { label: 'Claude is working', color: 'blue' },
  'needs-reply': { label: 'Needs your reply', color: 'yellow' },
  done: { label: 'Done', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  cancelled: { label: 'Cancelled', color: 'gray' }
}
