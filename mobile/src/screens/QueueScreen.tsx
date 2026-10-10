/**
 * Queue (Figma `19:126` / `19:796`): `RemoteQueueItem`s with status and agent badges; pause /
 * resume the queue; cancel, retry and open the run by the desktop's rules; "and N more".
 */

import type { RemoteQueueItem } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, View } from 'react-native'
import { DELIVERY_COPY } from '../remote/commands'
import type { CommandView } from '../remote/model'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { Card } from '../ui/Card'
import { FadeIn } from '../ui/FadeIn'
import { AGENT_LABEL, QUEUE_STATUS, canCancel, canRetry, isToday, queueCounts, queueMeta } from '../ui/format'
import { Icon } from '../ui/Icon'
import { PIPELINE_STATUS } from '../remote/pipeline'
import { Screen, ScreenHeader } from '../ui/Screen'
import { useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

const AGENT_TONE = { claude: 'ember', codex: 'trail', antigravity: 'review' } as const

function pendingFor(commands: CommandView[], item: RemoteQueueItem): CommandView | undefined {
  return commands.find((c) => (c.itemId === item.id || (item.runId !== null && c.runId === item.runId)) && (c.state === 'queued' || c.state === 'expired' || c.state === 'sent' || c.state === 'sending'))
}

function QueueCard({ item, all, index }: { item: RemoteQueueItem; all: readonly RemoteQueueItem[]; index: number }) {
  const model = useModel()
  const snap = useRemote()
  const now = useNow(1000)
  const status = QUEUE_STATUS[item.status]
  const meta = queueMeta(item, item.runId ? snap.runInfo[item.runId] : undefined, now)
  const pending = pendingFor(snap.commands, item)
  const openRun = item.runId ? () => router.push(`/run/${item.runId}`) : undefined
  const actions: React.ReactNode[] = []
  if (item.status === 'needs-reply' && item.runId) {
    actions.push(<Button key="reply" variant="primary" icon="send" label="Reply" onPress={openRun} />)
    actions.push(<Button key="open" variant="ghost" label="Open run" onPress={openRun} />)
  } else if (item.status === 'running' || item.status === 'preparing') {
    actions.push(<IconButton key="cancel" icon="x" label="Cancel" onPress={() => model.cancelItem(item.id)} />)
  } else if (item.status === 'queued') {
    actions.push(<IconButton key="cancel" icon="trash" label="Remove from the queue" onPress={() => model.cancelItem(item.id)} />)
  } else if (canRetry(item, all)) {
    actions.push(<Button key="retry" variant="outline" icon="refresh" label="Retry now" onPress={() => model.retryItem(item.id)} />)
    if (item.runId) actions.push(<Button key="open" variant="ghost" label="Open run" onPress={openRun} />)
  } else if (item.runId) {
    actions.push(<Button key="open" variant="ghost" label="Open run" onPress={openRun} />)
  }
  // A cancel is allowed for needs-reply too (desktop rule); it sits behind a long press to keep the card calm.
  const onLongPress = canCancel(item) && item.status === 'needs-reply' ? () => model.cancelItem(item.id) : undefined
  return (
    <FadeIn index={index}>
      <Pressable onPress={openRun} onLongPress={onLongPress} disabled={!openRun && !onLongPress} accessibilityLabel={item.title}>
        {({ pressed }) => (
          <Card padding={12} gap={8} style={pressed ? { opacity: 0.9 } : undefined}>
            <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
              <Badge tone={status.tone} dot live={status.live} label={status.label} />
              <Badge tone={AGENT_TONE[item.agent]} variant="outline" label={AGENT_LABEL[item.agent]} />
            </View>
            <Txt variant="labelMd" numberOfLines={2}>
              {item.title}
            </Txt>
            {meta ? (
              <Txt variant="monoXs" color="textMuted" numberOfLines={1}>
                {meta}
              </Txt>
            ) : null}
            {item.status === 'failed' && item.error ? (
              <Txt variant="bodyXs" color="danger" numberOfLines={3}>
                {item.error}
              </Txt>
            ) : null}
            {item.hasPendingReply ? (
              <Txt variant="bodyXs" color="textMuted">
                Your reply is held until one of the working runs finishes its turn.
              </Txt>
            ) : null}
            {pending && (pending.state === 'queued' || pending.state === 'expired') ? (
              <Txt variant="bodyXs" color={pending.state === 'expired' ? 'danger' : 'warning'}>
                {pending.label}: {DELIVERY_COPY[pending.state]}
              </Txt>
            ) : null}
            {actions.length > 0 && <View style={{ flexDirection: 'row', gap: 6, alignItems: 'flex-start' }}>{actions}</View>}
          </Card>
        )}
      </Pressable>
    </FadeIn>
  )
}

/** The pipeline lives under Queue (as in the Figma frames): one row to its screen while one exists. */
function PipelineLink() {
  const snap = useRemote()
  const colors = useColors()
  const status = snap.pipeline?.status ?? snap.status?.pipeline?.status ?? 'idle'
  if (status === 'idle' && !snap.lastPipeline) return null
  const badge = PIPELINE_STATUS[status]
  const c = snap.pipeline?.counts
  return (
    <Card padding={12} onPress={() => router.push('/pipeline')} accessibilityLabel="Unattended pipeline">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="cpu" size={16} color={colors.accentSecondary} />
        <Txt variant="labelMd" style={{ flex: 1 }}>
          Unattended pipeline{c ? ` · ${c.done} of ${c.total}` : ''}
        </Txt>
        <Badge tone={badge.tone} dot live={badge.live} label={badge.label} />
        <Icon name="chevron-right" size={14} color={colors.textMuted} />
      </View>
    </Card>
  )
}

export function QueueScreen() {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const now = useNow()
  const [showDone, setShowDone] = useState(false)
  useFocusEffect(
    useCallback(() => {
      if (!snap.demo) model.refreshQueue()
    }, [model, snap.demo])
  )
  const queue = snap.queue
  const items = queue?.items ?? []
  const counts = queueCounts(items, queue?.more ?? 0, now)
  // Finished jobs fold into one row; everything that can still change is a card.
  const open = items.filter((i) => i.status !== 'done')
  const done = items.filter((i) => i.status === 'done')
  const doneToday = done.filter((i) => isToday(i.updatedAt, now)).length
  const paused = queue?.paused ?? snap.status?.queue.paused ?? false
  return (
    <Screen scroll>
      <ScreenHeader
        eyebrow={queue ? `${counts.queued} queued · ${counts.working} working` : 'Loading…'}
        title="Queue"
        right={queue ? <Button variant="outline" icon={paused ? 'play' : 'pause'} label={paused ? 'Resume' : 'Pause'} onPress={() => model.setQueuePaused(!paused)} /> : null}
      />
      {paused && (
        <Txt variant="bodyXs" color="warning">
          The queue is paused: running jobs finish, nothing new starts.
        </Txt>
      )}
      <PipelineLink />
      {open.map((item, i) => (
        <QueueCard key={item.id} item={item} all={items} index={i} />
      ))}
      {queue && open.length === 0 && done.length === 0 && (
        <Card>
          <Txt variant="bodySm" color="textSecondary">
            Nothing in the queue. Add saved jobs from your Mac or from Jobs.
          </Txt>
        </Card>
      )}
      {(queue?.more ?? 0) > 0 && (
        <Txt variant="monoSm" color="textMuted" align="center">
          and {queue!.more} more on your Mac
        </Txt>
      )}
      {done.length > 0 && (
        <Pressable accessibilityRole="button" onPress={() => setShowDone(!showDone)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name="circle-check" size={16} color={colors.success} />
          <Txt variant="labelMd" color="textSecondary" style={{ flex: 1 }}>
            {done.length} done{doneToday > 0 && doneToday < done.length ? ` · ${doneToday} today` : doneToday === done.length ? ' today' : ''}
          </Txt>
          <View style={{ transform: [{ rotate: showDone ? '90deg' : '0deg' }] }}>
            <Icon name="chevron-right" size={14} color={colors.textMuted} />
          </View>
        </Pressable>
      )}
      {showDone && done.map((item, i) => <QueueCard key={item.id} item={item} all={items} index={i} />)}
      <Button variant="secondary" size="md" icon="plus" label="Add saved jobs to the queue" onPress={() => router.push('/jobs')} />
    </Screen>
  )
}
