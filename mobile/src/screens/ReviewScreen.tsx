/**
 * Review detail (#42, Figma `19:353` / `19:1023`): everything `ReviewDetail` carries (state,
 * the verify result, page previews fetched with `file.get` and checked against this
 * revision's hashes, the reframings to tick one by one, open gaps, the notes, the report) and
 * the three decisions. A decision echoes the revision the phone was served and only ids it
 * listed; Approve unlocks once page 1 of each document has loaded. `stale` and `denied` reload
 * the detail and say why (never "pair again"); a truncated detail is approved on the Mac.
 */

import { LIMITS, truncateUtf8, utf8Bytes, type RemoteFile, type ReviewDetail } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native'
import { fileKey, pageNumber, utf8Text } from '../remote/files'
import { REVIEW_STATE, approvalGate, canRerun, isDecidable, keepTicks, requiredPreviews, shortRevision } from '../remote/review'
import { useModel, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Badge } from '../ui/Badge'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { Checkbox, ConfirmButton, SectionLabel } from '../ui/Controls'
import { FadeIn } from '../ui/FadeIn'
import { Icon } from '../ui/Icon'
import { PagePreview } from '../ui/PagePreview'
import { Screen, ScreenHeader } from '../ui/Screen'
import { radius, type, useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

export function filesHref(applicationId: string): `/files?app=${string}` {
  return `/files?app=${encodeURIComponent(applicationId)}`
}

function Previews({ d }: { d: ReviewDetail }) {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const shown = requiredPreviews(d).filter((f) => pageNumber(f) !== null)
  if (shown.length === 0) return null
  return (
    <FadeIn>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ borderRadius: radius.lg, backgroundColor: colors.bgSurfaceSunken }} contentContainerStyle={{ padding: 10, gap: 8 }}>
        {shown.map((file) => {
          const listed = d.artifacts.find((a) => a.file === file)
          return <PagePreview key={file} view={snap.files[fileKey(d.applicationId, file)]} onPress={() => router.push(filesHref(d.applicationId))} onRetry={() => model.fetchFile(d.applicationId, file, listed?.sha256)} />
        })}
      </ScrollView>
    </FadeIn>
  )
}

function Reframings({ d, ticked, onToggle, decidable }: { d: ReviewDetail; ticked: Set<string>; onToggle: (id: string) => void; decidable: boolean }) {
  const colors = useColors()
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>Reframings the run left out</SectionLabel>
      {d.parseWarning ? <Alert tone="warning">{d.parseWarning}</Alert> : null}
      {d.proposedReframings.length === 0 && !d.parseWarning ? (
        <Txt variant="bodySm" color="textSecondary">
          None: everything in the resume is a direct hit or a standing approval.
        </Txt>
      ) : null}
      {d.proposedReframings.map((r, i) => {
        const on = ticked.has(r.id)
        return (
          <FadeIn key={r.id} index={i}>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on, disabled: !decidable }}
              accessibilityLabel={`Approve R${i + 1}: ${r.wording}`}
              disabled={!decidable}
              onPress={() => onToggle(r.id)}
              style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start', padding: 9, borderRadius: radius.md, borderWidth: 1, borderColor: on ? colors.accentPrimary : colors.borderSubtle, backgroundColor: on ? colors.accentPrimarySoft : colors.bgSurface }}
            >
              <Checkbox checked={on} disabled={!decidable} />
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="monoXs" color="textMuted">
                  R{i + 1} · {r.sourceFact}
                </Txt>
                <Txt variant="bodySm">{r.wording}</Txt>
              </View>
            </Pressable>
          </FadeIn>
        )
      })}
      {d.truncated ? (
        <Txt variant="bodyXs" color="warning">
          Some of this result was too long for the phone (a reframing that does not fit is left out). Approve on the Mac.
        </Txt>
      ) : ticked.size > 0 ? (
        <Txt variant="bodyXs" color="textMuted">
          Ticked reframings become standing approvals: later unattended runs may use them as written, for any job.
        </Txt>
      ) : null}
    </View>
  )
}

function Collapsible({ label, children, initiallyOpen = false }: { label: string; children: React.ReactNode; initiallyOpen?: boolean }) {
  const [open, setOpen] = useState(initiallyOpen)
  const colors = useColors()
  return (
    <View style={{ gap: 8 }}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={() => setOpen(!open)} style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Txt variant="monoSm" color="textMuted" style={{ flex: 1 }}>
          {label}
        </Txt>
        <View style={{ transform: [{ rotate: open ? '90deg' : '0deg' }] }}>
          <Icon name="chevron-right" size={14} color={colors.textMuted} />
        </View>
      </Pressable>
      {open ? children : null}
    </View>
  )
}

function Notes({ d }: { d: ReviewDetail }) {
  const snap = useRemote()
  const view = d.reviewNotes === null ? snap.files[fileKey(d.applicationId, 'review-notes.md')] : undefined
  const text = useMemo(() => (d.reviewNotes ?? (view?.state === 'ready' && view.data ? utf8Text(view.data) : null)), [d.reviewNotes, view])
  return (
    <Collapsible label="Review notes">
      <Card padding={12}>
        {text !== null ? (
          <Txt variant="bodySm" selectable>
            {text}
          </Txt>
        ) : (
          <Txt variant="bodyXs" color={view?.state === 'failed' ? 'danger' : 'textMuted'}>
            {view?.state === 'failed' ? (view.error ?? 'The notes could not be loaded.') : 'Loading review-notes.md…'}
          </Txt>
        )}
      </Card>
    </Collapsible>
  )
}

function Decisions({ d, ticked }: { d: ReviewDetail; ticked: Set<string> }) {
  const model = useModel()
  const snap = useRemote()
  const colors = useColors()
  const view = snap.review[d.applicationId]
  const [rerunOpen, setRerunOpen] = useState(false)
  const [answers, setAnswers] = useState('')
  const gate = approvalGate(d, (file: RemoteFile) => model.verifiedSha(d.applicationId, file))
  const busy = view?.deciding
  const n = ticked.size
  if (!isDecidable(d)) return null
  return (
    <View style={{ gap: 8 }}>
      <Button size="md" variant="primary" icon="check" label={`Approve${n ? ` (+${n} standing)` : ''}`} disabled={!gate.ok || !!busy} busy={busy === 'approve'} onPress={() => model.approve(d.applicationId, ticked)} style={gate.ok ? { shadowColor: colors.accentPrimary, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: { width: 0, height: 0 } } : undefined} />
      {!gate.ok ? (
        <Txt variant="bodyXs" color={gate.reason === 'loading' ? 'textMuted' : 'warning'} align="center">
          {gate.message}
        </Txt>
      ) : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {canRerun(d) ? <Button grow size="md" variant="outline" icon="refresh" label="Re-run with answers" disabled={!!busy} onPress={() => setRerunOpen(!rerunOpen)} /> : null}
        <ConfirmButton size="md" variant="danger" icon="trash" label="Discard" confirmLabel="Discard? Files are kept" disabled={!!busy} busy={busy === 'discard'} onConfirm={() => model.discard(d.applicationId)} grow={!canRerun(d)} />
      </View>
      {rerunOpen && canRerun(d) ? (
        <Card gap={8}>
          <Txt variant="monoSm" color="textMuted">
            Your decisions
          </Txt>
          <TextInput
            value={answers}
            onChangeText={(v) => setAnswers(utf8Bytes(v) > LIMITS.textBytes ? truncateUtf8(v, LIMITS.textBytes).text : v)}
            multiline
            placeholder="e.g. Use R1 but say “contributed to”, not “led”. Drop R2."
            placeholderTextColor={colors.textMuted}
            accessibilityLabel="Your decisions"
            style={[type.bodySm, { color: colors.textPrimary, minHeight: 84, maxHeight: 180, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken, textAlignVertical: 'top' }]}
          />
          <Txt variant="bodyXs" color="textMuted">
            Sent to the run's own session, like Re-run on your Mac. The result comes back here as Unreviewed with a new revision.
          </Txt>
          <Button
            variant="primary"
            icon="send"
            label="Send and rebuild"
            disabled={!answers.trim() || !!busy}
            busy={busy === 'rerun'}
            onPress={() => {
              if (model.rerun(d.applicationId, answers)) {
                setAnswers('')
                setRerunOpen(false)
              }
            }}
          />
        </Card>
      ) : null}
    </View>
  )
}

export function ReviewScreen({ applicationId }: { applicationId: string }) {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const view = snap.review[applicationId]
  const d = view?.detail ?? null
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  useFocusEffect(
    useCallback(() => {
      model.openReview(applicationId)
      return () => model.closeReview(applicationId)
    }, [model, applicationId])
  )
  // A new revision keeps only the ticks of reframings it still lists.
  const revision = d?.revision
  useEffect(() => {
    if (d) setTicked((t) => keepTicks(d, t))
  }, [revision]) // d changes with revision; ticks follow the revision only
  const state = d?.state ? REVIEW_STATE[d.state] : REVIEW_STATE.unreviewed
  const toggle = (id: string) =>
    setTicked((t) => {
      const next = new Set(t)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  return (
    <Screen scroll>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to the review list" onPress={() => router.navigate('/review')}>
        <ScreenHeader
          eyebrow={d ? `${state.label} · revision ${shortRevision(d.revision)}` : 'Review'}
          title={d?.title ?? 'Loading…'}
          right={d ? <Badge size="md" tone={d.verify.ok ? 'success' : 'danger'} label={d.verify.ok ? 'ATS passed' : 'Checks failed'} /> : null}
        />
      </Pressable>
      {view?.notice ? (
        <Alert tone="info" title="Reloaded">
          {view.notice}
        </Alert>
      ) : null}
      {view?.error && !d ? <Alert tone="danger">{view.error}</Alert> : null}
      {!d && view?.loading ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Txt variant="bodyXs" color="textMuted">
            Loading the result…
          </Txt>
        </View>
      ) : null}
      {d ? (
        <>
          {d.state === 'approved' || d.state === 'discarded' ? (
            <Alert tone="info" title={d.state === 'approved' ? 'Approved' : 'Discarded'}>
              {d.state === 'approved' ? 'This result is no longer Unreviewed. Applying stays on your Mac; nothing was submitted.' : 'Archived on your Mac. Every file is kept.'}
            </Alert>
          ) : null}
          {d.reason ? (
            <Alert tone="warning" title="Needs attention">
              {d.reason}
            </Alert>
          ) : null}
          <Previews d={d} />
          <Reframings d={d} ticked={ticked} onToggle={toggle} decidable={isDecidable(d) && !view?.deciding} />
          <Decisions d={d} ticked={ticked} />
          {d.openGaps.length > 0 ? (
            <View style={{ gap: 6 }}>
              <SectionLabel>Open gaps</SectionLabel>
              {d.openGaps.map((g, i) => (
                <View key={`${i}-${g}`} style={{ flexDirection: 'row', gap: 8 }}>
                  <Txt variant="bodySm" color="textMuted">
                    •
                  </Txt>
                  <Txt variant="bodySm" style={{ flex: 1 }}>
                    {g}
                  </Txt>
                </View>
              ))}
            </View>
          ) : null}
          <Notes d={d} />
          <Collapsible label={`Verify · ${d.verify.ok ? 'passed' : 'failed'}`}>
            <Card padding={12}>
              <Txt variant="monoXs" color="textSecondary" selectable>
                {d.verify.report || 'No build report.'}
              </Txt>
            </Card>
          </Collapsible>
          <Card padding={12} onPress={() => router.push(filesHref(d.applicationId))} accessibilityLabel="Files">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="file" size={16} color={colors.textAccent} />
              <View style={{ flex: 1 }}>
                <Txt variant="labelMd">Files</Txt>
                <Txt variant="bodyXs" color="textSecondary" numberOfLines={1}>
                  {d.artifacts.length} file{d.artifacts.length === 1 ? '' : 's'} · open the PDFs and every page
                </Txt>
              </View>
              <Icon name="chevron-right" size={14} color={colors.textMuted} />
            </View>
          </Card>
        </>
      ) : null}
    </Screen>
  )
}
