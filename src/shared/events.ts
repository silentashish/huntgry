/**
 * Main → renderer events (streaming output, file-watch notifications).
 * Each feature adds its channels to `HuntgryEvents` (channel → payload type)
 * and to `EVENT_CHANNELS`; preload refuses to subscribe to anything else.
 */

import type { ApplicationsEvents } from './applications-types'
import type { ApplyEvents } from './apply-types'
import type { BrowserEvents } from './browser-types'
import type { PipelineEvents } from './pipeline-types'
import type { QueueEvents } from './queue-types'
import type { RemoteEvents } from './remote-types'
import type { RunnerEvents } from './runner-types'

// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface HuntgryEvents
  extends RunnerEvents,
    ApplicationsEvents,
    BrowserEvents,
    QueueEvents,
    ApplyEvents,
    PipelineEvents,
    RemoteEvents {}

export type EventChannel = keyof HuntgryEvents

/** Runtime allowlist checked by preload; keep in sync with `HuntgryEvents`. */
export const EVENT_CHANNELS: readonly EventChannel[] = [
  'runner:event',
  'runner:run',
  'runner:install-log',
  'runner:prices',
  'applications:changed',
  'browser:state',
  'queue:changed',
  'apply:session',
  'pipeline:changed',
  'pipeline:finished',
  'remote:state'
]

/** Subscribe to a main-process event. Returns the unsubscribe function. */
export type Subscribe = <K extends EventChannel>(channel: K, listener: (payload: HuntgryEvents[K]) => void) => () => void
