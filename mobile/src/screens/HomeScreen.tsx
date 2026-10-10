/**
 * Home = the #38 "Status" screen (Figma `19:32` / `19:702`): Mac presence, the workspace name,
 * what needs the owner, the pipeline card (opens Pipeline, #41), queue counts, agent readiness. When the relay
 * says the Mac is offline it becomes the Offline screen (`19:614` / `19:1284`).
 */

import { DELIVERY_COPY } from '../remote/commands'
import type { RemoteSnapshot } from '../remote/model'
import { router } from 'expo-router'
import { Pressable, View } from 'react-native'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { FadeIn } from '../ui/FadeIn'
import { AGENT_LABEL, ago, clock, dayLine, queueCounts } from '../ui/format'
import { Icon, type IconName } from '../ui/Icon'
import { Progress } from '../ui/Progress'
import { PIPELINE_STATUS, SUMMARY_TITLE, etaText, summaryLine } from '../remote/pipeline'
import { Screen, ScreenHeader } from '../ui/Screen'
import { radius, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

export function PresenceBadge({ snap }: { snap: RemoteSnapshot }) {
  if (snap.connection === 'retrying' || snap.connection === 'replaced') return <Badge size="lg" tone="danger" dot label="Relay unreachable" />
  if (!snap.presence) return <Badge size="lg" tone="neutral" dot live label="Connecting…" />
  return snap.presence.online ? <Badge size="lg" tone="success" dot live label="Mac online" /> : <Badge size="lg" tone="warning" dot label="Mac asleep" />
}

export function HomeScreen() {
  const snap = useRemote()
  const now = useNow()
  const title = snap.status?.desktop.workspaceName ?? snap.workspace?.name ?? 'Huntgry'
  const header = <ScreenHeader eyebrow={dayLine(new Date(now))} title={title} right={<PresenceBadge snap={snap} />} />
  if (snap.presence && !snap.presence.online) {
    return (
      <Screen>
        {header}
        <Offline snap={snap} now={now} />
      </Screen>
    )
  }
  return (
    <Screen scroll>
      {header}
      <NeedsYou snap={snap} />
      <PipelineCard snap={snap} now={now} />
      <Tiles snap={snap} now={now} />
      <LimitAlert snap={snap} />
      <Agents snap={snap} />
    </Screen>
  )
}

// ── what needs the owner ─────────────────────────────────────────────────────────────────

function NeedsRow({ icon, text, onPress }: { icon: IconName; text: string; onPress: () => void }) {
  const colors = useColors()
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: 10, opacity: pressed ? 0.7 : 1 })}>
      <Icon name={icon} size={16} color={colors.textAccent} />
      <Txt variant="bodySm" style={{ flex: 1 }}>
        {text}
      </Txt>
      <Icon name="chevron-right" size={14} color={colors.textMuted} />
    </Pressable>
  )
}

function NeedsYou({ snap }: { snap: RemoteSnapshot }) {
  const status = snap.status
  if (!status) return null
  const waiting = snap.queue ? snap.queue.items.filter((i) => i.status === 'needs-reply') : []
  // The status counts the whole queue; the queue page may be cut at LIMITS.queueItems.
  const needsReply = Math.max(status.queue.needsReply, waiting.length)
  const rows: { icon: IconName; text: string; onPress: () => void }[] = []
  if (needsReply > 0) {
    rows.push({
      icon: 'send',
      text: `${needsReply} run${needsReply === 1 ? '' : 's'} waiting for your reply`,
      onPress: () => (waiting.length === 1 && waiting[0].runId ? router.push(`/run/${waiting[0].runId}`) : router.push('/queue'))
    })
  }
  if (status.review.unreviewed > 0) rows.push({ icon: 'clipboard-check', text: `${status.review.unreviewed} result${status.review.unreviewed === 1 ? '' : 's'} to review`, onPress: () => router.push('/review') })
  if (status.queue.failed > 0) rows.push({ icon: 'bolt', text: `${status.queue.failed} job${status.queue.failed === 1 ? '' : 's'} failed — retry from the queue`, onPress: () => router.push('/queue') })
  if (rows.length === 0) return null
  return (
    <FadeIn>
      <Card tone="accent">
        <Txt variant="headingMd" color="textAccent">
          {rows.length === 1 ? '1 thing needs you' : `${rows.length} things need you`}
        </Txt>
        {rows.map((r) => (
          <NeedsRow key={r.text} {...r} />
        ))}
      </Card>
    </FadeIn>
  )
}

// ── pipeline (#41: the card opens the Pipeline screen) ───────────────────────────────────

function PipelineCard({ snap, now }: { snap: RemoteSnapshot; now: number }) {
  const model = useModel()
  const colors = useColors()
  const state = snap.pipeline
  const status = state?.status ?? snap.status?.pipeline?.status ?? 'idle'
  const badge = PIPELINE_STATUS[status]
  const last = snap.lastPipeline
  const open = () => router.push('/pipeline')
  const head = (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
      <Icon name="cpu" size={16} color={colors.accentSecondary} />
      <Txt variant="headingSm" style={{ flex: 1 }}>
        Unattended pipeline
      </Txt>
      <Badge size="md" tone={badge.tone} dot live={badge.live} label={status === 'waiting-limit' ? 'Waiting' : badge.label} />
    </View>
  )
  if (!state) {
    const until = snap.status?.pipeline?.until
    const text =
      status === 'idle' || status === 'finished'
        ? last
          ? `${SUMMARY_TITLE[last.status]} at ${clock(last.finishedAt)}: ${summaryLine(last)}.`
          : 'No pipeline running. Pick saved jobs on Jobs to run them unattended.'
        : status === 'waiting-limit' && until
          ? `Waiting for the usage limit until ${clock(until)}.`
          : 'Progress shows with the next change your Mac sends.'
    return (
      <FadeIn index={1}>
        <Card onPress={open} accessibilityLabel="Pipeline">
          {head}
          <Txt variant="bodySm" color="textSecondary">
            {text}
          </Txt>
        </Card>
      </FadeIn>
    )
  }
  const c = state.counts
  const meta = [`${c.done} of ${c.total}`]
  const eta = etaText(state.eta, now)
  if (status === 'waiting-limit' && state.waitingLimitUntil) meta.push(`resumes ${clock(state.waitingLimitUntil)}`)
  else if (eta) meta.push(eta.replace('about ', '~').replace(' left', ''))
  if (c.running > 0) meta.push(`${c.running} running`)
  meta.push(AGENT_LABEL[state.agent])
  const live = status === 'running' || status === 'waiting-limit'
  return (
    <FadeIn index={1}>
      <Card onPress={open} accessibilityLabel="Pipeline">
        {head}
        <Progress value={c.total > 0 ? c.done / c.total : 0} />
        <Txt variant="monoSm" color="textMuted" numberOfLines={1}>
          {meta.join(' · ')}
        </Txt>
        {state.reason && status === 'paused' ? (
          <Txt variant="bodyXs" color="danger" numberOfLines={2}>
            {state.reason}
          </Txt>
        ) : null}
        {(live || status === 'paused') && (
          <View style={{ flexDirection: 'row', gap: 8 }}>
            {status === 'paused' ? (
              <Button grow variant="outline" icon="play" label="Resume" onPress={() => model.pipelineResume()} />
            ) : (
              <Button grow variant="outline" icon="pause" label="Pause" onPress={() => model.pipelinePause()} />
            )}
            <Button grow variant="ghost" label="Details" onPress={open} />
          </View>
        )}
      </Card>
    </FadeIn>
  )
}

// ── tiles, limit, agents ─────────────────────────────────────────────────────────────────

function Tile({ label, value, index }: { label: string; value: number | string; index: number }) {
  return (
    <FadeIn index={index} style={{ flex: 1 }}>
      <Card padding={12} gap={4}>
        <Txt variant="monoSm" color="textMuted" numberOfLines={1}>
          {label}
        </Txt>
        <Txt variant="displayMd">{value}</Txt>
      </Card>
    </FadeIn>
  )
}

function Tiles({ snap, now }: { snap: RemoteSnapshot; now: number }) {
  const status = snap.status
  if (!snap.queue && !status) return null
  const counts = snap.queue ? queueCounts(snap.queue.items, snap.queue.more ?? 0, now) : null
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <Tile index={2} label="Queued" value={counts ? counts.queued : '–'} />
      <Tile index={3} label="Working" value={counts ? counts.working : '–'} />
      <Tile index={4} label="Done today" value={counts ? counts.doneToday : '–'} />
    </View>
  )
}

function LimitAlert({ snap }: { snap: RemoteSnapshot }) {
  const p = snap.pipeline
  const until = p?.waitingLimitUntil ?? (snap.status?.pipeline?.status === 'waiting-limit' ? snap.status.pipeline.until : undefined)
  if (!until) return null
  const agent = p ? AGENT_LABEL[p.agent] : 'The agent'
  // The phone cannot tell whether this pipeline has a fallback agent (the desktop does not send
  // it), so it does not promise a switch.
  const body = 'Jobs not started yet wait for the reset, or go to the fallback agent if this pipeline has one. Nothing is lost.'
  return (
    <FadeIn index={5}>
      <Alert tone="warning" title={`${agent} limit resets ${clock(until)}`}>
        {body}
      </Alert>
    </FadeIn>
  )
}

function Agents({ snap }: { snap: RemoteSnapshot }) {
  const agents = snap.status?.agents
  if (!agents || agents.length === 0) return null
  return (
    <FadeIn index={6} style={{ gap: 8 }}>
      <Txt variant="monoSm" color="textMuted">
        Agents on your Mac
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {agents.map((a) => (
          <Badge key={a.id} size="md" tone={a.ready ? 'success' : 'neutral'} dot label={`${AGENT_LABEL[a.id]} ${a.ready ? 'ready' : 'not set up'}`} />
        ))}
      </View>
    </FadeIn>
  )
}

// ── offline ──────────────────────────────────────────────────────────────────────────────

function Offline({ snap, now }: { snap: RemoteSnapshot; now: number }) {
  const colors = useColors()
  const since = snap.presence?.since
  const waiting = snap.commands.filter((c) => c.state === 'queued' || c.state === 'expired').slice(0, 5)
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14 }}>
      <FadeIn>
        <View style={{ width: 88, height: 88, borderRadius: radius.full, backgroundColor: colors.warningSoft, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="wifi-off" size={36} color={colors.warning} />
        </View>
      </FadeIn>
      <Txt variant="headingXl" align="center">
        Your Mac is asleep
      </Txt>
      <Txt variant="bodySm" color="textSecondary" align="center" style={{ width: 300 }}>
        {since ? `Desktop offline since ${clock(since)}, ${ago(since, now)}. ` : ''}Commands you send now wait on the relay and run when it wakes; replies and new jobs expire after 2 hours, the rest after a day.
      </Txt>
      {waiting.length > 0 && (
        <FadeIn index={1} style={{ alignSelf: 'stretch', alignItems: 'center' }}>
          <Card padding={12} gap={8} style={{ width: 330, maxWidth: '100%' }}>
            <Txt variant="monoSm" color="textMuted">
              Queued on the relay
            </Txt>
            {waiting.map((c) => (
              <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name={c.name === 'run.reply' ? 'send' : c.name.startsWith('pipeline.') || c.name === 'queue.setPaused' ? 'pause' : 'terminal'} size={14} color={c.state === 'expired' ? colors.textMuted : colors.textPrimary} stroke={2} />
                <Txt variant="labelMd" color={c.state === 'expired' ? 'textMuted' : 'textPrimary'} style={{ flex: 1 }} numberOfLines={1}>
                  {c.label}
                </Txt>
                <Badge tone={c.state === 'expired' ? 'danger' : 'warning'} label={c.state === 'expired' ? 'expired' : 'will run when awake'} />
              </View>
            ))}
            <Txt variant="bodyXs" color="textMuted">
              {waiting.some((c) => c.state === 'expired') ? DELIVERY_COPY.expired : DELIVERY_COPY.queued}.
            </Txt>
          </Card>
        </FadeIn>
      )}
    </View>
  )
}
