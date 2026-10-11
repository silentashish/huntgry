import { useEffect, useState } from 'react'
import { Button, Group, Stack } from '@mantine/core'
import { IconClipboardCheck, IconCpu } from '@tabler/icons-react'
import type { PipelineCounts, PipelineSummary } from '@shared/pipeline-types'
import { api } from '../../api'
import { MonoLabel, SectionCard, StatusPill, type UiTone } from '../../components/ui'
import { useNavigation } from '../../navigation'
import classes from './dashboard.module.css'
import { shortDate } from './summary'

/** The count pills, in Figma order, each only when non-zero. */
const COUNT_PILLS: { key: keyof PipelineCounts; tone: UiTone; label: (n: number) => string }[] = [
  { key: 'unreviewed', tone: 'warning', label: (n) => `${n} ready to review` },
  { key: 'needsAttention', tone: 'accent', label: (n) => `${n} need${n === 1 ? 's' : ''} attention` },
  { key: 'approved', tone: 'success', label: (n) => `${n} approved` },
  { key: 'needsReply', tone: 'warning', label: (n) => `${n} need${n === 1 ? 's' : ''} your reply` },
  { key: 'discarded', tone: 'neutral', label: (n) => `${n} discarded` },
  { key: 'failed', tone: 'danger', label: (n) => `${n} failed` },
  { key: 'cancelled', tone: 'neutral', label: (n) => `${n} cancelled` },
  { key: 'skipped', tone: 'neutral', label: (n) => `${n} skipped` }
]

function durationText(startedAt: string, finishedAt: string): string {
  const mins = Math.max(1, Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 60_000))
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`
}

/** The morning card: what the last unattended pipeline did, and a link to review its results. */
export function LastPipelineCard() {
  const { navigate } = useNavigation()
  const [summary, setSummary] = useState<PipelineSummary | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void api.pipeline.lastSummary().then((s) => live && setSummary(s), () => undefined)
    load()
    const off = api.on('pipeline:finished', (s) => setSummary(s))
    // A result approved or discarded since is no longer "ready to review" (#72): main reads the states live.
    const offReview = api.on('applications:changed', load)
    return () => {
      live = false
      off()
      offReview()
    }
  }, [])
  if (!summary) return null
  const c = summary.counts
  const look = c.needsAttention + c.needsReply + c.failed
  const toReview = c.unreviewed + c.needsAttention
  const when = new Date(summary.finishedAt)
  const meta = [
    `${shortDate(summary.finishedAt)} ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`,
    durationText(summary.startedAt, summary.finishedAt),
    summary.costUsd > 0 ? `$${summary.costUsd.toFixed(2)}` : null
  ].filter(Boolean)
  return (
    <SectionCard
      title="Last unattended pipeline"
      titleOrder={4}
      icon={<IconCpu size={18} />}
      badge={
        <StatusPill tone="success" dot>
          Finished
        </StatusPill>
      }
      padding="md"
    >
      <Stack gap="sm">
        <MonoLabel component="div" title={when.toLocaleString()}>
          {meta.join(' · ')}
        </MonoLabel>
        <div className={classes.pills}>
          {COUNT_PILLS.filter((p) => c[p.key] > 0).map((p) => (
            <StatusPill key={p.key} tone={p.tone}>
              {p.label(c[p.key])}
            </StatusPill>
          ))}
        </div>
        {summary.stopReason && <p className={classes.cardLine}>{summary.stopReason}</p>}
        {(toReview > 0 || look - c.needsAttention > 0) && (
          <Group gap="xs">
            {toReview > 0 && (
              <Button size="xs" variant="secondary" leftSection={<IconClipboardCheck size={14} />} onClick={() => navigate('review')}>
                Review {toReview} result{toReview === 1 ? '' : 's'}
              </Button>
            )}
            {look - c.needsAttention > 0 && (
              <Button size="xs" variant="subtle" onClick={() => navigate('tailor', { view: 'queue' })}>
                Open the queue
              </Button>
            )}
          </Group>
        )}
      </Stack>
    </SectionCard>
  )
}
