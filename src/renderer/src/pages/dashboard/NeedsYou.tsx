import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { IconArrowRight, IconBolt, IconClipboardCheck, IconSend } from '@tabler/icons-react'
import type { ApplicationRecord } from '@shared/applications-types'
import type { ReviewItem } from '@shared/review-types'
import { AGENT_LABEL, type RunSummary } from '@shared/runner-types'
import { api } from '../../api'
import { toneStyle, type UiTone } from '../../components/ui'
import classes from './dashboard.module.css'
import { listNames } from './summary'

export interface NeedsYouData {
  /** Tailor runs whose agent finished its turn and waits for the user's reply. */
  waiting: RunSummary[]
  /** Unattended results waiting on the Review page. */
  review: ReviewItem[]
}

/**
 * The runs and review items behind the "Needs you" strip, live: runs change on `runner:run`,
 * review states on `applications:changed`, and both are re-read when the window regains focus.
 * `reload` is the page's Refresh.
 */
export function useNeedsYou(): NeedsYouData & { reload(): void } {
  const [waiting, setWaiting] = useState<RunSummary[]>([])
  const [review, setReview] = useState<ReviewItem[]>([])
  const runsRequest = useRef(0)
  const reviewRequest = useRef(0)

  const loadRuns = useCallback(() => {
    const mine = ++runsRequest.current
    api.runner.listRuns().then(
      (runs) => runsRequest.current === mine && setWaiting(runs.filter((r) => r.status === 'waiting')),
      () => undefined
    )
  }, [])
  const loadReview = useCallback(() => {
    const mine = ++reviewRequest.current
    api.review.list().then(
      (items) => reviewRequest.current === mine && setReview(items),
      () => undefined
    )
  }, [])
  const reload = useCallback(() => {
    loadRuns()
    loadReview()
  }, [loadRuns, loadReview])

  useEffect(() => {
    reload()
    // A run's status changes at every turn end; coalesce bursts while a batch runs.
    let timer: ReturnType<typeof setTimeout> | null = null
    const runsSoon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(loadRuns, 400)
    }
    const offRun = api.on('runner:run', runsSoon)
    const offApps = api.on('applications:changed', loadReview)
    const offPipeline = api.on('pipeline:finished', loadReview)
    window.addEventListener('focus', reload)
    return () => {
      if (timer) clearTimeout(timer)
      offRun()
      offApps()
      offPipeline()
      window.removeEventListener('focus', reload)
    }
  }, [reload, loadRuns, loadReview])

  return { waiting, review, reload }
}

/** How many "Needs you" cards show: each kind with something in it counts once. */
export function needsYouCount(data: NeedsYouData, ready: readonly ApplicationRecord[]): number {
  return [data.waiting.length, data.review.length, ready.length].filter((n) => n > 0).length
}

interface Props extends NeedsYouData {
  ready: ApplicationRecord[]
  onReply(run: RunSummary): void
  onReview(): void
  onApply(): void
}

/** Reply / review / apply: what waits on the user before the hunt moves on (Figma Dashboard → NeedsYou). */
export function NeedsYouStrip({ waiting, review, ready, onReply, onReview, onApply }: Props) {
  if (waiting.length + review.length + ready.length === 0) return null
  const agents = [...new Set(waiting.map((r) => AGENT_LABEL[r.agent]))]
  return (
    <section className={classes.needs} aria-label="Needs you">
      {waiting.length > 0 && (
        <NeedCard
          tone="warning"
          icon={<IconSend size={16} />}
          title={`${waiting.length} run${waiting.length === 1 ? '' : 's'} waiting for your reply`}
          sub={`${listNames(agents)} asked about ${listNames(waiting.map((r) => r.title))}`}
          action="Reply"
          onAction={() => onReply(waiting[0])}
        />
      )}
      {review.length > 0 && (
        <NeedCard
          tone="review"
          icon={<IconClipboardCheck size={16} />}
          title={`${review.length} result${review.length === 1 ? '' : 's'} to review`}
          sub={`Built unattended: ${listNames(review.map((r) => r.title))}`}
          action="Review"
          onAction={onReview}
        />
      )}
      {ready.length > 0 && (
        <NeedCard
          tone="accent"
          icon={<IconBolt size={16} />}
          title={`${ready.length} ready to apply`}
          sub={`${listNames(ready.map((a) => `${a.jobTitle || a.role} · ${a.company}`))} · resume built`}
          action="Apply"
          onAction={onApply}
        />
      )}
    </section>
  )
}

function NeedCard(props: { tone: UiTone; icon: ReactNode; title: string; sub: string; action: string; onAction(): void }) {
  return (
    <div className={classes.needCard}>
      <span className={classes.needIcon} style={toneStyle(props.tone)} aria-hidden>
        {props.icon}
      </span>
      <div className={classes.needText}>
        <p className={classes.needTitle}>{props.title}</p>
        <p className={classes.needSub} title={props.sub}>
          {props.sub}
        </p>
      </div>
      <Button size="xs" variant="default" className={classes.needAction} rightSection={<IconArrowRight size={14} />} onClick={props.onAction}>
        {props.action}
      </Button>
    </div>
  )
}
