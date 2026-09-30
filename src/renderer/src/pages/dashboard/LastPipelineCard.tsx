import { useEffect, useState } from 'react'
import { Anchor, Badge, Card, Group, Stack, Text, Title } from '@mantine/core'
import { IconRobot } from '@tabler/icons-react'
import type { PipelineSummary } from '@shared/pipeline-types'
import { api } from '../../api'
import { useNavigation } from '../../navigation'

/** The morning card: what the last unattended pipeline did, and a link to review its results. */
export function LastPipelineCard() {
  const { navigate } = useNavigation()
  const [summary, setSummary] = useState<PipelineSummary | null>(null)
  useEffect(() => {
    let live = true
    api.pipeline.lastSummary().then((s) => live && setSummary(s), () => undefined)
    const off = api.on('pipeline:finished', (s) => setSummary(s))
    return () => {
      live = false
      off()
    }
  }, [])
  if (!summary) return null
  const c = summary.counts
  const look = c.needsAttention + c.needsReply + c.failed
  const when = new Date(summary.finishedAt)
  const mins = Math.max(1, Math.round((Date.parse(summary.finishedAt) - Date.parse(summary.startedAt)) / 60_000))
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" align="flex-start">
        <Group gap="xs">
          <IconRobot size={18} />
          <Title order={4}>Last unattended pipeline</Title>
        </Group>
        <Text size="xs" c="dimmed">
          {when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} · {mins} min
          {summary.costUsd > 0 ? ` · $${summary.costUsd.toFixed(2)}` : ''}
        </Text>
      </Group>
      <Stack gap={6} mt="sm">
        <Group gap={6}>
          {c.unreviewed > 0 && (
            <Badge variant="light" color="yellow">
              {c.unreviewed} ready to review
            </Badge>
          )}
          {c.needsAttention > 0 && (
            <Badge variant="light" color="orange">
              {c.needsAttention} need attention
            </Badge>
          )}
          {c.needsReply > 0 && (
            <Badge variant="light" color="yellow">
              {c.needsReply} need your reply
            </Badge>
          )}
          {c.failed > 0 && (
            <Badge variant="light" color="red">
              {c.failed} failed
            </Badge>
          )}
          {c.cancelled > 0 && (
            <Badge variant="light" color="gray">
              {c.cancelled} cancelled
            </Badge>
          )}
          {c.skipped > 0 && (
            <Badge variant="light" color="gray">
              {c.skipped} skipped
            </Badge>
          )}
        </Group>
        {summary.stopReason && (
          <Text size="sm" c="dimmed">
            {summary.stopReason}
          </Text>
        )}
        <Group gap="md">
          {c.unreviewed + c.needsAttention > 0 && (
            <Anchor component="button" size="sm" onClick={() => navigate('review')}>
              Review {c.unreviewed + c.needsAttention} result{c.unreviewed + c.needsAttention === 1 ? '' : 's'}
            </Anchor>
          )}
          {look - c.needsAttention > 0 && (
            <Anchor component="button" size="sm" onClick={() => navigate('tailor', { view: 'queue' })}>
              Open the queue
            </Anchor>
          )}
        </Group>
      </Stack>
    </Card>
  )
}
