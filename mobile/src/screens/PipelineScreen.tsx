/**
 * Pipeline (#41, Figma `19:224` / `19:894`): the unattended pipeline as the desktop panel shows
 * it, from `pipeline.changed` / `pipeline.finished` (and the status heartbeat until the first
 * change arrives): progress, the usage-limit wait with its reset time, why it paused or
 * failed, the counts, Pause / Resume / Stop, and the last summary. Starting one is the sheet
 * on Jobs (pick saved jobs first). Nothing here approves, applies or submits.
 */

import type { PipelineState, PipelineStatus, PipelineSummary } from '@huntgry/remote-protocol'
import { router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { DELIVERY_COPY } from '../remote/commands'
import type { RemoteSnapshot } from '../remote/model'
import { PIPELINE_STATUS, SUMMARY_TITLE, countBadges, etaText, pipelineControl, summaryLine } from '../remote/pipeline'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { ConfirmButton } from '../ui/Controls'
import { FadeIn } from '../ui/FadeIn'
import { AGENT_LABEL, clock, money } from '../ui/format'
import { Icon } from '../ui/Icon'
import { Progress } from '../ui/Progress'
import { Screen, ScreenHeader } from '../ui/Screen'
import { useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

/** The command of a kind the owner sent and the Mac has not answered (asleep: queued on the relay). */
function pendingPipeline(snap: RemoteSnapshot) {
  return snap.commands.find((c) => c.name.startsWith('pipeline.') && (c.state === 'sending' || c.state === 'sent' || c.state === 'queued' || c.state === 'expired'))
}

function Hero({ p, now }: { p: PipelineState; now: number }) {
  const c = p.counts
  const agent = AGENT_LABEL[p.agent]
  const waiting = p.status === 'waiting-limit' && p.waitingLimitUntil
  const eta = etaText(p.eta, now)
  const caption = waiting
    ? `${agent}'s limit resets · resumes by itself`
    : p.status === 'paused'
      ? 'built · paused, nothing new starts'
      : p.status === 'finished'
        ? 'built · finished'
        : `built${eta ? ` · ${eta}` : ''}`
  return (
    <FadeIn>
      <Card padding={16} gap={10} style={{ alignItems: 'center' }}>
        <Txt variant="displayXl" color="textAccent" accessibilityLabel={waiting ? `Resumes at ${clock(p.waitingLimitUntil!)}` : `${c.done} of ${c.total} built`}>
          {waiting ? clock(p.waitingLimitUntil!) : `${c.done}/${c.total}`}
        </Txt>
        <Txt variant="bodySm" color="textSecondary" align="center">
          {caption}
        </Txt>
        <View style={{ alignSelf: 'stretch' }}>
          <Progress value={c.total > 0 ? c.done / c.total : 0} />
        </View>
        <Txt variant="monoSm" color="textMuted" align="center">
          {c.done} of {c.total} jobs · started {clock(p.startedAt)}
        </Txt>
      </Card>
    </FadeIn>
  )
}

function Counts({ p }: { p: PipelineState }) {
  const badges = countBadges(p.counts)
  if (badges.length === 0) return null
  return (
    <FadeIn index={1} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
      {badges.map((b) => (
        <Badge key={b.label} size="md" tone={b.tone} label={b.label} />
      ))}
    </FadeIn>
  )
}

function Controls({ status, snap }: { status: PipelineStatus; snap: RemoteSnapshot }) {
  const model = useModel()
  const pending = pendingPipeline(snap)
  const busy = pending?.state === 'sending' || pending?.state === 'sent'
  const control = pipelineControl(status)
  if (!control) return null
  return (
    <FadeIn index={2} style={{ gap: 8 }}>
      {control === 'resume' ? (
        <Button size="md" variant="primary" icon="play" label="Resume pipeline" busy={busy && pending?.name === 'pipeline.resume'} onPress={() => model.pipelineResume()} />
      ) : (
        <Button size="md" variant="outline" icon="pause" label="Pause pipeline" busy={busy && pending?.name === 'pipeline.pause'} onPress={() => model.pipelinePause()} />
      )}
      <ConfirmButton size="md" variant="danger" icon="stop" label="Stop pipeline" confirmLabel="Tap again to stop every run" busy={busy && pending?.name === 'pipeline.stop'} onConfirm={() => model.pipelineStop()} />
      {pending && (pending.state === 'queued' || pending.state === 'expired') ? (
        <Txt variant="bodyXs" color={pending.state === 'expired' ? 'danger' : 'warning'}>
          {pending.label}: {DELIVERY_COPY[pending.state]}
        </Txt>
      ) : null}
    </FadeIn>
  )
}

function Summary({ s }: { s: PipelineSummary }) {
  const colors = useColors()
  return (
    <FadeIn>
      <Card gap={8}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Icon name={s.status === 'finished' ? 'flag-check' : 'stop'} size={16} color={s.status === 'finished' ? colors.success : colors.warning} />
          <Txt variant="headingSm" style={{ flex: 1 }}>
            {SUMMARY_TITLE[s.status]}
          </Txt>
          <Txt variant="monoSm" color="textMuted">
            {clock(s.finishedAt)}
          </Txt>
        </View>
        <Txt variant="bodySm" color="textSecondary">
          {summaryLine(s)}
        </Txt>
        <Txt variant="monoSm" color="textMuted">
          {money(s.costUsd)} · started {clock(s.startedAt)}
        </Txt>
        {s.counts.unreviewed + (s.counts.needsAttention ?? 0) > 0 ? <Button variant="outline" icon="clipboard-check" label="Review the results" onPress={() => router.navigate('/review')} /> : null}
      </Card>
    </FadeIn>
  )
}

export function PipelineScreen() {
  const snap = useRemote()
  const now = useNow(15_000)
  const p = snap.pipeline
  const fromStatus = snap.status?.pipeline ?? null
  const status = p?.status ?? fromStatus?.status ?? 'idle'
  const badge = PIPELINE_STATUS[status]
  const offline = snap.presence !== null && !snap.presence.online
  const eyebrow = p ? `Unattended · ${AGENT_LABEL[p.agent]}` : 'Unattended'
  return (
    <Screen scroll>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to the queue" onPress={() => router.navigate('/queue')}>
        <ScreenHeader eyebrow={eyebrow} title="Pipeline" right={status !== 'idle' ? <Badge size="md" tone={badge.tone} dot live={badge.live} label={badge.label} /> : null} />
      </Pressable>
      {p ? (
        <>
          <Hero p={p} now={now} />
          <Counts p={p} />
          {p.reason && p.status !== 'running' ? (
            <Alert tone={p.status === 'waiting-limit' ? 'warning' : p.status === 'paused' ? 'danger' : 'info'} title={p.status === 'waiting-limit' ? 'Usage limit' : p.status === 'paused' ? 'Paused' : undefined}>
              {p.reason}
            </Alert>
          ) : null}
          {p.counts.failed > 0 && p.status === 'running' ? (
            <Alert tone="danger" title={`${p.counts.failed} job${p.counts.failed === 1 ? '' : 's'} failed`}>
              The pipeline carries on with the rest. Retry them from the queue.
            </Alert>
          ) : null}
          <Controls status={p.status} snap={snap} />
        </>
      ) : fromStatus && fromStatus.status !== 'idle' && fromStatus.status !== 'finished' ? (
        <>
          <Card gap={8}>
            <Txt variant="headingSm">{fromStatus.status === 'waiting-limit' && fromStatus.until ? `Waiting for the usage limit until ${clock(fromStatus.until)}` : `The pipeline is ${badge.label.toLowerCase()}`}</Txt>
            <Txt variant="bodySm" color="textSecondary">
              Progress shows with the next change your Mac sends.
            </Txt>
          </Card>
          <Controls status={fromStatus.status} snap={snap} />
        </>
      ) : (
        <Card gap={10}>
          <Txt variant="headingSm">No pipeline running</Txt>
          <Txt variant="bodySm" color="textSecondary">
            Pick saved jobs on Jobs and run them unattended: the Mac tailors them with the agent and concurrency you choose, and every result waits for your review. Nothing is applied or submitted.
          </Txt>
          <Button variant="primary" size="md" icon="briefcase" label="Choose jobs" onPress={() => router.navigate('/jobs')} />
        </Card>
      )}
      {snap.lastPipeline ? <Summary s={snap.lastPipeline} /> : null}
      {offline ? (
        <Alert tone="info" icon="moon">
          Will run when your Mac wakes. Pause, resume and stop wait on the relay for up to a day; a new pipeline expires after 2 hours.
        </Alert>
      ) : null}
    </Screen>
  )
}
