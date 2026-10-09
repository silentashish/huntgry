/**
 * Review (#42): the Unreviewed results from `review.list`, newest first, like the desktop's
 * list. There is no "approve all": a result is approved only from its own detail, after its
 * previews loaded. Refreshed on `review.needed` and `applications.changed`.
 */

import type { ReviewItem } from '@huntgry/remote-protocol'
import { router, useFocusEffect } from 'expo-router'
import { useCallback } from 'react'
import { ActivityIndicator, RefreshControl, View } from 'react-native'
import { REVIEW_STATE } from '../remote/review'
import { useModel, useNow, useRemote } from '../state/RemoteProvider'
import { Badge } from '../ui/Badge'
import { Card } from '../ui/Card'
import { FadeIn } from '../ui/FadeIn'
import { ago } from '../ui/format'
import { Icon } from '../ui/Icon'
import { Screen, ScreenHeader } from '../ui/Screen'
import { useColors } from '../ui/theme'
import { Txt } from '../ui/Txt'

export function reviewHref(applicationId: string): `/result?app=${string}` {
  return `/result?app=${encodeURIComponent(applicationId)}`
}

function Row({ item, index, now }: { item: ReviewItem; index: number; now: number }) {
  const colors = useColors()
  const state = REVIEW_STATE[item.state ?? 'unreviewed']
  return (
    <FadeIn index={index}>
      <Card padding={12} gap={8} onPress={() => router.push(reviewHref(item.applicationId))} accessibilityLabel={`${item.title}, ${state.label}`}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Badge tone={state.tone} dot label={state.label} />
          {item.openGaps > 0 ? <Badge tone="neutral" variant="outline" label={`${item.openGaps} open gap${item.openGaps === 1 ? '' : 's'}`} /> : null}
          <View style={{ flex: 1 }} />
          <Icon name="chevron-right" size={14} color={colors.textMuted} />
        </View>
        <Txt variant="labelMd" numberOfLines={2}>
          {item.title}
        </Txt>
        <Txt variant="monoXs" color="textMuted">
          built {ago(item.finishedAt, now)}
        </Txt>
        {item.reason ? (
          <Txt variant="bodyXs" color="textSecondary" numberOfLines={3}>
            {item.reason}
          </Txt>
        ) : null}
      </Card>
    </FadeIn>
  )
}

export function ReviewListScreen() {
  const snap = useRemote()
  const model = useModel()
  const colors = useColors()
  const now = useNow()
  useFocusEffect(
    useCallback(() => {
      model.loadReviews()
    }, [model])
  )
  const reviews = snap.reviews
  const items = reviews?.items ?? []
  const count = items.length + (reviews?.more ?? 0)
  return (
    <Screen scroll refreshControl={<RefreshControl refreshing={!!reviews?.loading && items.length > 0} onRefresh={() => model.loadReviews()} tintColor={colors.textMuted} />}>
      <ScreenHeader eyebrow={reviews ? `${count} waiting for you` : 'Revision-bound approvals'} title="Review" />
      {items.map((item, i) => (
        <Row key={item.applicationId} item={item} index={i} now={now} />
      ))}
      {(reviews?.more ?? 0) > 0 ? (
        <Txt variant="monoSm" color="textMuted" align="center">
          and {reviews!.more} more on your Mac
        </Txt>
      ) : null}
      {reviews?.loading && items.length === 0 ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="small" color={colors.textMuted} />
          <Txt variant="bodyXs" color="textMuted">
            Loading results…
          </Txt>
        </View>
      ) : null}
      {reviews && !reviews.loading && items.length === 0 && !reviews.error ? (
        <Card gap={8}>
          <Txt variant="headingSm">Nothing to review</Txt>
          <Txt variant="bodySm" color="textSecondary">
            Results of unattended runs wait here until you approve, re-run or discard them.
          </Txt>
        </Card>
      ) : null}
      {reviews?.error ? (
        <Txt variant="bodyXs" color="danger">
          {reviews.error}
        </Txt>
      ) : null}
    </Screen>
  )
}
