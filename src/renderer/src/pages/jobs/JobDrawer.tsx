import { useState } from 'react'
import { Alert, Badge, Button, Drawer, Group, ScrollArea, Stack, Text } from '@mantine/core'
import { IconDownload, IconExternalLink, IconEyeOff, IconSparkles } from '@tabler/icons-react'
import { canFetchDetails, type Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { SOURCE_LABEL } from './labels'

interface Props {
  job: Job | null
  onClose(): void
  onChange(job: Job): void
  /** Resolves once the job has been handed to the Tailor page (after fetching its full posting, when possible). */
  onTailor(job: Job): Promise<void>
}

/** One job: full description (or the board's summary), and what to do with it. */
export function JobDrawer({ job, onClose, onChange, onTailor }: Props) {
  const [busy, setBusy] = useState<'details' | 'dismiss' | 'tailor' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(kind: 'details' | 'dismiss', fn: () => Promise<Job>) {
    setBusy(kind)
    setError(null)
    try {
      onChange(await fn())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function tailor(job: Job) {
    setBusy('tailor')
    setError(null)
    try {
      await onTailor(job)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Drawer
      opened={job !== null}
      onClose={() => {
        setError(null)
        onClose()
      }}
      position="right"
      size="xl"
      title={job && <Text fw={600}>{job.title}</Text>}
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {job && (
        <Stack gap="md">
          <Group gap="xs">
            <Badge variant="light">{SOURCE_LABEL[job.source]}</Badge>
            {job.remote && (
              <Badge variant="light" color="teal">
                Remote
              </Badge>
            )}
            {job.tailoredAt && (
              <Badge variant="light" color="green">
                Sent to tailor
              </Badge>
            )}
            {job.dismissed && (
              <Badge variant="light" color="gray">
                Dismissed
              </Badge>
            )}
          </Group>
          <Text size="sm">
            {[job.company, job.location, job.salary].filter(Boolean).join(' · ')}
            {job.postedAt &&
              ` · posted ${new Date(job.postedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}
          </Text>
          <Group gap="xs">
            <Button
              leftSection={<IconSparkles size={16} />}
              loading={busy === 'tailor'}
              disabled={busy !== null && busy !== 'tailor'}
              onClick={() => void tailor(job)}
            >
              Tailor resume
            </Button>
            <Button
              variant="default"
              component="a"
              href={job.url}
              target="_blank"
              rel="noreferrer"
              leftSection={<IconExternalLink size={16} />}
            >
              Open posting
            </Button>
            {/* An Indeed job can still be fetched through a copy of it found on another board. */}
            {canFetchDetails(job) && (
              <Button
                variant="light"
                leftSection={<IconDownload size={16} />}
                loading={busy === 'details'}
                disabled={busy === 'tailor'}
                onClick={() => act('details', () => api.jobs.fetchDetails(job.id))}
              >
                Fetch full description
              </Button>
            )}
            <Button
              variant="subtle"
              color="gray"
              leftSection={<IconEyeOff size={16} />}
              loading={busy === 'dismiss'}
              onClick={() => act('dismiss', () => api.jobs.update(job.id, { dismissed: !job.dismissed }))}
            >
              {job.dismissed ? 'Restore' : 'Dismiss'}
            </Button>
          </Group>
          {busy === 'tailor' && canFetchDetails(job) && (
            <Text size="sm" c="dimmed">
              Fetching the full posting from the employer’s page before tailoring…
            </Text>
          )}
          {error && (
            <Alert color="orange" variant="light" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}
          {!job.descriptionComplete && (
            <Alert color="blue" variant="light">
              {job.source === 'indeed'
                ? 'Indeed search results include only a snippet, and its job pages need a human check. Tailor resume sends this snippet with the job’s details; for a better resume, open the posting and paste the full description on the Tailor page (or with “Paste a job”).'
                : 'This is the job board’s summary, not the full posting. Tailor resume fetches the full description from the employer’s page first, and falls back to this summary if it cannot.'}
            </Alert>
          )}
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {job.description || 'No description.'}
          </Text>
          {job.tags.length > 0 && (
            <Group gap={6}>
              {job.tags.map((t) => (
                <Badge key={t} variant="outline" color="gray" size="sm">
                  {t}
                </Badge>
              ))}
            </Group>
          )}
        </Stack>
      )}
    </Drawer>
  )
}
