import type { RunStatus } from '@shared/runner-types'

export const STATUS_LABEL: Record<RunStatus, { label: string; color: string }> = {
  running: { label: 'Claude is working', color: 'blue' },
  waiting: { label: 'Waiting for you', color: 'yellow' },
  finished: { label: 'Finished', color: 'green' },
  failed: { label: 'Failed', color: 'red' },
  stopped: { label: 'Stopped', color: 'gray' }
}
