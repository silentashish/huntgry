/**
 * Run view (Figma `19:295` / `19:965`): the transcript, paged with `run.get` + `sinceSeq` and
 * kept in memory only; truncated items say "open on your Mac for the full output"; a reply
 * box capped at 32 KiB, held while the queue holds a reply; finish / stop.
 */

import { LIMITS, truncateUtf8, utf8Bytes, type RemoteRun, type RemoteTranscriptItem } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native'
import Animated from 'react-native-reanimated'
import { useModel, useRemote } from '../state/RemoteProvider'
import { Badge } from '../ui/Badge'
import { Button, IconButton } from '../ui/Button'
import { FadeIn } from '../ui/FadeIn'
import { AGENT_LABEL, RUN_STATUS, duration, money } from '../ui/format'
import { Icon } from '../ui/Icon'
import { Screen, ScreenHeader } from '../ui/Screen'
import { radius, type, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

const TRUNCATED = 'Cut short here: open on your Mac for the full output.'

function Truncated() {
  return (
    <Txt variant="bodyXs" color="textMuted" style={{ fontStyle: 'italic' }}>
      {TRUNCATED}
    </Txt>
  )
}

function Spinner({ color }: { color: string }) {
  return (
    <Animated.View style={{ animationName: { from: { transform: [{ rotate: '0deg' }] }, to: { transform: [{ rotate: '360deg' }] } }, animationDuration: '1400ms', animationIterationCount: 'infinite', animationTimingFunction: 'linear' }}>
      <Icon name="refresh" size={12} color={color} />
    </Animated.View>
  )
}

function Item({ item, run }: { item: RemoteTranscriptItem; run: RemoteRun }) {
  const colors = useColors()
  const agent = AGENT_LABEL[run.agent]
  switch (item.kind) {
    case 'assistant':
      return (
        <View style={{ backgroundColor: colors.bgSurface, borderColor: colors.borderSubtle, borderWidth: 1, borderRadius: radius.lg, paddingHorizontal: 11, paddingVertical: 9, gap: 6 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Icon name="sparkles" size={12} color={colors.textAccent} />
            <Txt variant="labelSm" color="textAccent">
              {agent}
            </Txt>
          </View>
          <Txt variant="bodySm" selectable>
            {item.text}
          </Txt>
          {item.truncated && <Truncated />}
        </View>
      )
    case 'user':
      return (
        <View style={{ alignItems: 'flex-end' }}>
          <View style={{ backgroundColor: colors.accentPrimarySoft, borderRadius: radius.lg, paddingHorizontal: 12, paddingVertical: 8, maxWidth: 280, minWidth: 120, gap: 4 }}>
            <Txt variant="bodySm" selectable>
              {item.text}
            </Txt>
            {item.truncated && <Truncated />}
          </View>
        </View>
      )
    case 'notice':
      return (
        <View style={{ gap: 2 }}>
          <Txt variant="bodyXs" color={item.level === 'error' ? 'danger' : 'textMuted'}>
            {item.text}
          </Txt>
          {item.truncated && <Truncated />}
        </View>
      )
    case 'tool': {
      const running = item.status === 'running'
      const color = item.status === 'error' ? colors.danger : running ? colors.info : colors.textMuted
      return (
        <View style={{ gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {running ? <Spinner color={color} /> : <Icon name={item.status === 'error' ? 'alert-circle' : 'check'} size={12} color={color} />}
            <Txt variant="bodyXs" color="textSecondary" style={{ flex: 1 }} numberOfLines={2}>
              {running ? `${agent} is working… ${item.summary}` : item.summary}
            </Txt>
          </View>
          {item.truncated && <Truncated />}
        </View>
      )
    }
    case 'result':
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Icon name={item.ok ? 'circle-check' : 'alert-circle'} size={12} color={item.ok ? colors.success : colors.danger} />
          <Txt variant="bodyXs" color="textSecondary" style={{ flex: 1 }}>
            {item.ok ? 'Turn finished' : 'Turn failed'} · {duration(item.durationMs)} · {money(item.costUsd)}
            {item.denials.length > 0 ? ` · ${item.denials.length} action${item.denials.length === 1 ? '' : 's'} denied` : ''}
          </Txt>
        </View>
      )
  }
}

function ReplyBox({ run }: { run: RemoteRun }) {
  const model = useModel()
  const colors = useColors()
  const [text, setText] = useState('')
  const held = model.replyHeld(run.id)
  const open = run.status === 'waiting' && !held
  const bytes = utf8Bytes(text)
  const send = () => {
    if (!text.trim() || !open) return
    try {
      if (model.reply(run.id, text)) setText('')
    } catch {
      model.toast('That reply cannot be sent.')
    }
  }
  const placeholder = held ? 'Your reply is held until a slot frees up…' : open ? `Reply to ${AGENT_LABEL[run.agent]}…` : run.live ? `Replies open when ${AGENT_LABEL[run.agent]} asks` : 'This run has ended'
  return (
    <View style={{ gap: 6 }}>
      {bytes > LIMITS.textBytes * 0.85 && (
        <Txt variant="monoXs" color={bytes >= LIMITS.textBytes ? 'danger' : 'textMuted'} align="right">
          {Math.ceil(bytes / 1024)} / {LIMITS.textBytes / 1024} KiB
        </Txt>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, padding: 7, borderRadius: radius.xl, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceRaised }}>
        <TextInput
          value={text}
          // The 32 KiB cap counts UTF-8 bytes (LIMITS.textBytes), not characters.
          onChangeText={(v) => setText(utf8Bytes(v) > LIMITS.textBytes ? truncateUtf8(v, LIMITS.textBytes).text : v)}
          editable={open}
          multiline
          numberOfLines={1}
          placeholder={placeholder}
          placeholderTextColor={colors.textMuted}
          accessibilityLabel="Reply"
          style={[
            type.bodySm,
            { flex: 1, color: colors.textPrimary, minHeight: 36, maxHeight: 120, paddingHorizontal: 11, paddingVertical: 7, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken },
            !open && { opacity: 0.6 }
          ]}
        />
        <IconButton variant="primary" icon="send" label="Send reply" onPress={send} disabled={!open} />
      </View>
    </View>
  )
}

export function RunScreen({ runId }: { runId: string }) {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const scroll = useRef<ScrollView>(null)
  useFocusEffect(
    useCallback(() => {
      model.openRun(runId)
    }, [model, runId])
  )
  const view = snap.runs[runId]
  const run = view?.run ?? snap.runInfo[runId] ?? null
  const status = run ? RUN_STATUS[run.status] : null
  const canEnd = run && (run.status === 'waiting' || run.status === 'running')
  return (
    <Screen footer={run ? <ReplyBox run={run} /> : undefined}>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to the queue" onPress={() => router.navigate('/queue')}>
        <ScreenHeader
          eyebrow={run && status ? `${AGENT_LABEL[run.agent]} · ${status.eyebrow}` : 'Run'}
          title={run?.title ?? 'Loading…'}
          right={status ? <Badge size="md" tone={status.tone} dot live={status.live} label={status.badge} /> : null}
        />
      </Pressable>
      {canEnd && (
        <View style={{ flexDirection: 'row', gap: 6, justifyContent: 'flex-end', marginTop: -6 }}>
          <Button variant="ghost" icon="flag-check" label="Finish" onPress={() => model.finishRun(runId)} />
          <Button variant="danger" icon="stop" label="Stop" onPress={() => model.stopRun(runId)} />
        </View>
      )}
      <ScrollView ref={scroll} style={{ flex: 1 }} contentContainerStyle={{ gap: 10 }} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })}>
        {run && view?.items.map((item, i) => (
          <FadeIn key={item.id} index={i}>
            <Item item={item} run={run} />
          </FadeIn>
        ))}
        {view?.loading && (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <ActivityIndicator size="small" color={colors.textMuted} />
            <Txt variant="bodyXs" color="textMuted">
              Loading the transcript…
            </Txt>
          </View>
        )}
        {view?.error && (
          <Txt variant="bodyXs" color="danger">
            {view.error}
          </Txt>
        )}
        {view && !view.loading && !view.complete && (
          <View style={{ alignItems: 'flex-start' }}>
            <Button variant="ghost" icon="refresh" label={view.error ? 'Try again' : 'Load more'} onPress={() => model.loadMoreRun(runId)} />
          </View>
        )}
        {view && view.complete && view.items.length === 0 && (
          <Txt variant="bodyXs" color="textMuted">
            No transcript on the phone for this run. It shows here when “Show transcripts on phone” is on in desktop Settings.
          </Txt>
        )}
      </ScrollView>
    </Screen>
  )
}
