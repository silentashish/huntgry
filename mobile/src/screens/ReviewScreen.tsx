/**
 * Review detail (#42, Figma `19:353` / `19:1023`): everything `ReviewDetail` carries (state,
 * the verify result, page previews fetched with `file.get` and checked against this
 * revision's hashes, the reframings to tick one by one, open gaps, the notes, the report) and
 * the three decisions. A decision echoes the revision the phone was served and only ids it
 * listed; Approve unlocks once page 1 of each document has loaded. On a Mac with #159 each
 * reframing the run used shows its rule and can be rejected (with a better wording), and
 * Re-run needs no typed answers: it redoes the result with the reframing rules. `stale` and `denied` reload
 * the detail and say why (never "pair again"); a truncated detail is approved on the Mac.
 */

import { LIMITS, truncateUtf8, utf8Bytes, type RemoteFile, type RemoteReframing, type ReviewDetail, type ReviewReframings } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native'
import { fileKey, pageNumber, utf8Text } from '../remote/files'
import { REVIEW_STATE, approvalGate, canReject, canRerun, canRerunWithoutAnswers, isDecidable, keepTicks, reframingsFor, requiredPreviews, shortRevision } from '../remote/review'
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

function Reframings({ d, r, ticked, onToggle, decidable }: { d: ReviewDetail; r: ReviewReframings | null; ticked: Set<string>; onToggle: (id: string) => void; decidable: boolean }) {
  const colors = useColors()
  const used = r?.format === 'v2'
  // #159: the Mac's list carries each reframing's rule (and its requirement); an older Mac sends the detail's only.
  const rows: RemoteReframing[] = r ? r.reframings : d.proposedReframings
  return (
    <View style={{ gap: 10 }}>
      <SectionLabel>{used ? 'Reframings used' : 'Reframings the run left out'}</SectionLabel>
      {d.parseWarning ? <Alert tone="warning">{d.parseWarning}</Alert> : null}
      {rows.length === 0 && !d.parseWarning ? (
        <Txt variant="bodySm" color="textSecondary">
          {used ? 'None: everything in the resume is a direct hit.' : 'None: everything in the resume is a direct hit or a standing approval.'}
        </Txt>
      ) : null}
      {rows.map((x, i) => {
        const on = ticked.has(x.id)
        const rejected = x.rule === 'rejected' && !on
        return (
          <FadeIn key={x.id} index={i}>
            <View style={{ gap: 6, padding: 9, borderRadius: radius.md, borderWidth: 1, borderColor: rejected ? colors.danger : on ? colors.accentPrimary : colors.borderSubtle, backgroundColor: on ? colors.accentPrimarySoft : colors.bgSurface }}>
              <Pressable
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on, disabled: !decidable }}
                accessibilityLabel={`${used ? 'Keep' : 'Approve'} R${i + 1}: ${x.wording}`}
                disabled={!decidable}
                onPress={() => onToggle(x.id)}
                style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}
              >
                <Checkbox checked={on} disabled={!decidable} />
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt variant="monoXs" color="textMuted">
                    R{i + 1}
                    {x.requirement ? ` · ${x.requirement}` : ''} · {x.sourceFact}
                  </Txt>
                  <Txt variant="bodySm" color={rejected ? 'textSecondary' : undefined} style={rejected ? { textDecorationLine: 'line-through' } : undefined}>
                    {x.wording}
                  </Txt>
                  {rejected && x.betterWording ? (
                    <Txt variant="bodySm">
                      <Txt variant="monoXs" color="textMuted">
                        Use instead{' '}
                      </Txt>
                      {x.betterWording}
                    </Txt>
                  ) : null}
                </View>
              </Pressable>
              {r && used && decidable ? <RejectRow d={d} r={r} item={x} index={i} /> : null}
            </View>
          </FadeIn>
        )
      })}
      {d.truncated || r?.truncated ? (
        <Txt variant="bodyXs" color="warning">
          Some of this result was too long for the phone (a reframing that does not fit is left out). Decide on it on the Mac.
        </Txt>
      ) : ticked.size > 0 ? (
        <Txt variant="bodyXs" color="textMuted">
          Ticked reframings become preferred wordings: later runs may use them as written, for any job.
        </Txt>
      ) : null}
    </View>
  )
}

/** #159: Reject (with an optional better wording) under one reframing the run used, or its Rejected mark. */
function RejectRow({ d, r, item, index }: { d: ReviewDetail; r: ReviewReframings; item: RemoteReframing; index: number }) {
  const model = useModel()
  const snap = useRemote()
  const colors = useColors()
  const [open, setOpen] = useState(false)
  const [better, setBetter] = useState('')
  const view = snap.review[d.applicationId]
  const busy = !!view?.rejecting || !!view?.deciding
  if (!canReject(r, item))
    return (
      <View style={{ flexDirection: 'row', paddingLeft: 30 }}>
        <Badge tone="danger" dot label="Rejected" />
      </View>
    )
  if (!open)
    return (
      <View style={{ flexDirection: 'row', paddingLeft: 30 }}>
        <Button size="sm" variant="ghost" icon="x" label={`Reject R${index + 1}`} disabled={busy} onPress={() => setOpen(true)} />
      </View>
    )
  return (
    <View style={{ gap: 6, paddingLeft: 30 }}>
      <TextInput
        value={better}
        onChangeText={(v) => setBetter(utf8Bytes(v) > LIMITS.reviewEntryBytes ? truncateUtf8(v, LIMITS.reviewEntryBytes).text : v)}
        placeholder="Better wording (optional)"
        placeholderTextColor={colors.textMuted}
        accessibilityLabel="Better wording (optional)"
        style={[type.bodySm, { color: colors.textPrimary, padding: 8, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken }]}
      />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          size="sm"
          variant="danger"
          icon="x"
          label={`Reject R${index + 1}`}
          disabled={busy}
          busy={view?.rejecting === item.id}
          onPress={() => {
            if (model.reject(d.applicationId, item.id, better)) {
              setOpen(false)
              setBetter('')
            }
          }}
        />
        <Button size="sm" variant="ghost" label="Cancel" disabled={busy} onPress={() => setOpen(false)} />
      </View>
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

function Decisions({ d, r, ticked }: { d: ReviewDetail; r: ReviewReframings | null; ticked: Set<string> }) {
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
        {canRerun(d) ? <Button grow size="md" variant="outline" icon="refresh" label="Re-run" disabled={!!busy} onPress={() => setRerunOpen(!rerunOpen)} /> : null}
        <ConfirmButton size="md" variant="danger" icon="trash" label="Discard" confirmLabel="Discard? Files are kept" disabled={!!busy} busy={busy === 'discard'} onConfirm={() => model.discard(d.applicationId)} grow={!canRerun(d)} />
      </View>
      {rerunOpen && canRerun(d) ? (
        <Card gap={8}>
          <Txt variant="monoSm" color="textMuted">
            {canRerunWithoutAnswers(r) ? 'Notes for the re-run (optional)' : 'Your decisions'}
          </Txt>
          <TextInput
            value={answers}
            onChangeText={(v) => setAnswers(utf8Bytes(v) > LIMITS.textBytes ? truncateUtf8(v, LIMITS.textBytes).text : v)}
            multiline
            placeholder="e.g. Use R1 but say “contributed to”, not “led”. Drop R2."
            placeholderTextColor={colors.textMuted}
            accessibilityLabel={canRerunWithoutAnswers(r) ? 'Notes for the re-run' : 'Your decisions'}
            style={[type.bodySm, { color: colors.textPrimary, minHeight: 84, maxHeight: 180, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: colors.borderDefault, backgroundColor: colors.bgSurfaceSunken, textAlignVertical: 'top' }]}
          />
          <Txt variant="bodyXs" color="textMuted">
            {canRerunWithoutAnswers(r)
              ? 'Redoes this result in the run’s own session with your reframing rules, like Re-run on your Mac. It comes back here as Unreviewed with a new revision.'
              : "Sent to the run's own session, like Re-run on your Mac. The result comes back here as Unreviewed with a new revision."}
          </Txt>
          <Button
            variant="primary"
            icon="send"
            label={canRerunWithoutAnswers(r) ? 'Re-run' : 'Send and rebuild'}
            disabled={(!answers.trim() && !canRerunWithoutAnswers(r)) || !!busy}
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
  const r = d ? reframingsFor(d, view?.reframings) : null
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
          <Reframings d={d} r={r} ticked={ticked} onToggle={toggle} decidable={isDecidable(d) && !view?.deciding} />
          <Decisions d={d} r={r} ticked={ticked} />
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
