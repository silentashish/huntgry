/**
 * Files (#40): one application's files as the review listed them (PDFs, page previews, the
 * notes). Each is fetched with `file.get`, reassembled from its chunks and kept only when its
 * SHA-256 matches; then a page shows inline and a PDF opens in the OS viewer (share sheet).
 * Nothing is written outside the app's cache, and that copy is removed when the app comes
 * back. Refreshes with the review detail on `applications.changed`.
 */

import type { RemoteFile, ReviewDetail } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { Pressable, View } from 'react-native'
import { fileKey, fileLabel, fileSize, isPage, mimeOf, pageNumber } from '../remote/files'
import type { FileView } from '../remote/model'
import { useModel, useRemote } from '../state/RemoteProvider'
import { openFile, shareName } from '../state/share'
import { Button } from '../ui/Button'
import { Card } from '../ui/Card'
import { SectionLabel } from '../ui/Controls'
import { FadeIn } from '../ui/FadeIn'
import { Icon } from '../ui/Icon'
import { PagePreview } from '../ui/PagePreview'
import { Screen, ScreenHeader } from '../ui/Screen'
import { useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

function status(view: FileView | undefined, bytes: number): { text: string; tone: 'textMuted' | 'success' | 'danger' } {
  if (!view) return { text: fileSize(bytes), tone: 'textMuted' }
  switch (view.state) {
    case 'ready':
      return { text: `${fileSize(view.bytes)} · checksum verified`, tone: 'success' }
    case 'failed':
      return { text: view.error ?? 'Could not load this file.', tone: 'danger' }
    case 'loading':
      return { text: `Loading ${view.received} of ${view.of}…`, tone: 'textMuted' }
    default:
      return { text: 'Waiting for your Mac…', tone: 'textMuted' }
  }
}

function DocumentRow({ d, file, bytes, sha256, index }: { d: ReviewDetail; file: RemoteFile; bytes: number; sha256?: string; index: number }) {
  const model = useModel()
  const snap = useRemote()
  const colors = useColors()
  const view = snap.files[fileKey(d.applicationId, file)]
  const s = status(view, bytes)
  const ready = view?.state === 'ready' && view.data
  const open = async () => {
    if (!ready) return
    try {
      await openFile(shareName(d.title, file), view.data!, mimeOf(file))
    } catch (err) {
      model.toast((err as Error).message || 'This file could not be opened.')
    }
  }
  return (
    <FadeIn index={index}>
      <Card padding={12}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name={file.endsWith('.md') ? 'file-text' : 'file'} size={18} color={colors.textAccent} />
          <View style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <Txt variant="labelMd">{fileLabel(file)}</Txt>
            <Txt variant="monoXs" color={s.tone} numberOfLines={2}>
              {s.text}
            </Txt>
          </View>
          {ready ? (
            <Button variant="outline" icon="share" label="Open" onPress={open} />
          ) : view?.state === 'waiting' || view?.state === 'loading' ? null : (
            <Button variant="secondary" icon={view?.state === 'failed' ? 'refresh' : 'chevron-down'} label={view?.state === 'failed' ? 'Retry' : 'Load'} onPress={() => model.fetchFile(d.applicationId, file, sha256)} />
          )}
        </View>
      </Card>
    </FadeIn>
  )
}

export function FilesScreen({ applicationId }: { applicationId: string }) {
  const snap = useRemote()
  const model = useModel()
  const view = snap.review[applicationId]
  const d = view?.detail ?? null
  useFocusEffect(
    useCallback(() => {
      model.watchReview(applicationId)
      return () => model.closeReview(applicationId)
    }, [model, applicationId])
  )
  const docs = d ? d.artifacts.filter((a) => !isPage(a.file)) : []
  const notesListed = d?.artifacts.some((a) => a.file === 'review-notes.md')
  // Resume pages first, then the cover letter's, each in page order (2 before 10).
  const order = (f: RemoteFile) => (f.startsWith('resume') ? 0 : 1) * 1000 + (pageNumber(f) ?? 0)
  const pages = d ? d.artifacts.filter((a) => isPage(a.file)).sort((a, b) => order(a.file) - order(b.file)) : []
  const unloaded = d ? pages.filter((p) => snap.files[fileKey(d.applicationId, p.file)]?.state !== 'ready') : []
  return (
    <Screen scroll>
      <Pressable accessibilityRole="button" accessibilityLabel="Back to the result" onPress={() => router.navigate(`/result?app=${encodeURIComponent(applicationId)}`)}>
        <ScreenHeader eyebrow="Files" title={d?.title ?? 'Loading…'} />
      </Pressable>
      {d ? (
        <>
          <SectionLabel>Documents</SectionLabel>
          {docs.map((a, i) => (
            <DocumentRow key={a.file} d={d} file={a.file} bytes={a.bytes} sha256={a.sha256} index={i} />
          ))}
          {!notesListed && d.reviewNotes === null ? <DocumentRow d={d} file="review-notes.md" bytes={0} index={docs.length} /> : null}
          {pages.length > 0 ? (
            <SectionLabel right={unloaded.length > 0 ? <Button variant="ghost" label={`Load all ${pages.length}`} onPress={() => unloaded.forEach((p) => model.fetchFile(d.applicationId, p.file, p.sha256))} /> : undefined}>Page previews</SectionLabel>
          ) : null}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {pages.map((p) => {
              const fv = snap.files[fileKey(d.applicationId, p.file)]
              return (
                <View key={p.file} style={{ gap: 4 }}>
                  <PagePreview view={fv} width={165} height={213} onPress={fv?.state === 'ready' ? undefined : () => model.fetchFile(d.applicationId, p.file, p.sha256)} onRetry={() => model.fetchFile(d.applicationId, p.file, p.sha256)} />
                  <Txt variant="monoXs" color="textMuted">
                    {fileLabel(p.file)}
                  </Txt>
                </View>
              )
            })}
          </View>
          <Txt variant="bodyXs" color="textMuted">
            Every file is checked against the SHA-256 your Mac sent before it is shown or opened. Files stay in memory while the app is open; an opened copy is removed when you come back.
          </Txt>
        </>
      ) : view?.error ? (
        <Txt variant="bodyXs" color="danger">
          {view.error}
        </Txt>
      ) : null}
    </Screen>
  )
}
