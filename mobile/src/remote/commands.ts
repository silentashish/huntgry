/**
 * Typed builders over `RemoteCommand` (the package's allow-list). Every builder runs the
 * package's `requireCommand`, so an oversized reply or a malformed id throws here, on the
 * phone, before anything is sealed or counted. `envelopeFor` turns a command into the
 * `Envelope` the relay client seals: `ws` from the last `StatusSummary` (all but
 * `status.get` / `device.*`), `ttl` from `ttlFor`, a uuid `id`.
 */

import {
  COMMAND_TTL_SECONDS,
  NOTIFICATION_CATEGORIES,
  WORKSPACE_FREE_COMMANDS,
  requireCommand,
  ttlFor,
  type Envelope,
  type NotificationCategory,
  type RemoteCommand,
  type RemoteCommandArgs,
  type RemoteCommandName,
  type RemoteEnqueueInput,
  type RelayNotice
} from '@huntgry/remote-protocol'

/** A validated command (`requireCommand` ran). */
export type Command = RemoteCommand

function build<N extends RemoteCommandName>(name: N, args?: RemoteCommandArgs<N>): Command {
  return requireCommand(name, args)
}

export const commands = {
  status: () => build('status.get'),
  queue: () => build('queue.get'),
  setQueuePaused: (paused: boolean) => build('queue.setPaused', { paused }),
  cancel: (itemId: string) => build('queue.cancel', { itemId }),
  retry: (itemId: string) => build('queue.retry', { itemId }),
  enqueue: (input: RemoteEnqueueInput) => build('queue.enqueue', input),
  pipelinePause: () => build('pipeline.pause'),
  pipelineResume: () => build('pipeline.resume'),
  pipelineStop: () => build('pipeline.stop'),
  runs: (cursor?: string) => build('runs.list', cursor === undefined ? {} : { cursor }),
  run: (runId: string, sinceSeq?: number) => build('run.get', sinceSeq === undefined ? { runId } : { runId, sinceSeq }),
  reply: (runId: string, text: string) => build('run.reply', { runId, text }),
  finish: (runId: string) => build('run.finish', { runId }),
  stop: (runId: string) => build('run.stop', { runId }),
  setNotifications: (categories: readonly NotificationCategory[]) =>
    // Sent in the package's order so the same choice always reads the same.
    build('device.setNotifications', { categories: NOTIFICATION_CATEGORIES.filter((c) => categories.includes(c)) })
}

/** Whether a command needs `Envelope.ws`. */
export function needsWorkspace(name: RemoteCommandName): boolean {
  return !(WORKSPACE_FREE_COMMANDS as readonly string[]).includes(name)
}

export class NoWorkspaceError extends Error {
  constructor() {
    super('Waiting for your Mac to say which workspace is open.')
    this.name = 'NoWorkspaceError'
  }
}

export interface EnvelopeInput {
  command: Command
  id: string
  sid: string
  seq: number
  now: number
  /** The open workspace's id from the last `StatusSummary` (or the desktop's `hello`). */
  workspaceId: string | null
  ttls?: { costly: number; default: number }
}

/** The plaintext of one command frame. */
export function envelopeFor(input: EnvelopeInput): Envelope {
  const { command } = input
  const env: Envelope = {
    v: 1,
    sid: input.sid,
    from: 'phone',
    seq: input.seq,
    ts: new Date(input.now).toISOString(),
    ttl: ttlFor(command.name, input.ttls ?? COMMAND_TTL_SECONDS),
    kind: 'cmd',
    id: input.id,
    name: command.name,
    body: 'args' in command ? command.args : null
  }
  if (needsWorkspace(command.name)) {
    if (!input.workspaceId) throw new NoWorkspaceError()
    env.ws = input.workspaceId
  }
  return env
}

// ── what the owner sees for a command that has not been answered ──────────────────────────────

export type DeliveryState = 'sending' | 'sent' | 'queued' | 'expired' | 'too-large' | 'done' | 'failed'

/** The copy for a waiting command (ADR "Offline behaviour"). */
export const DELIVERY_COPY: Record<DeliveryState, string> = {
  sending: 'Sending…',
  sent: 'Sent to your Mac',
  queued: 'Will run when your Mac wakes',
  expired: 'Expired before your Mac woke up',
  'too-large': 'Too large to send',
  done: 'Done',
  failed: 'Failed'
}

/** The state a relay notice moves a sent command to, or null when it is not about a command. */
export function deliveryFromNotice(notice: RelayNotice): { ref: string; state: DeliveryState } | null {
  // Presence carries a `queued` count too: it is not about one command.
  if ('presence' in notice) return null
  if ('queued' in notice) return { ref: notice.ref, state: 'queued' }
  if ('expired' in notice) return { ref: notice.ref, state: 'expired' }
  if ('tooLarge' in notice) return { ref: notice.ref, state: 'too-large' }
  return null
}

/** A short label for a command in the "Queued on the relay" list. */
export function commandLabel(command: Command, runTitle?: (runId: string) => string | undefined): string {
  switch (command.name) {
    case 'queue.setPaused':
      return command.args.paused ? 'Pause queue' : 'Resume queue'
    case 'queue.cancel':
      return 'Cancel job'
    case 'queue.retry':
      return 'Retry job'
    case 'queue.enqueue':
      return `Queue ${command.args.jobIds.length} job${command.args.jobIds.length === 1 ? '' : 's'}`
    case 'pipeline.pause':
      return 'Pause pipeline'
    case 'pipeline.resume':
      return 'Resume pipeline'
    case 'pipeline.stop':
      return 'Stop pipeline'
    case 'run.reply': {
      const title = runTitle?.(command.args.runId)
      return title ? `Reply · ${title}` : 'Reply'
    }
    case 'run.finish':
      return 'Finish run'
    case 'run.stop':
      return 'Stop run'
    case 'device.setNotifications':
      return 'Notification settings'
    default:
      return command.name
  }
}
