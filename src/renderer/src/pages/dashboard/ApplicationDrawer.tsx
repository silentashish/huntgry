import { useEffect, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Drawer,
  Group,
  Image,
  ScrollArea,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Tooltip
} from '@mantine/core'
import { IconExternalLink, IconFileTypePdf, IconFolder } from '@tabler/icons-react'
import { APPLICATION_STATUSES, type ApplicationRecord, type ApplicationTracking } from '@shared/applications-types'
import { api, errorText } from '../../api'
import { STATUS_META } from './status'

interface Props {
  app: ApplicationRecord | null
  onClose(): void
  onUpdate(patch: Partial<ApplicationTracking>): Promise<void>
}

/** One application: page previews, the saved job description, tracking and notes. */
export function ApplicationDrawer({ app, onClose, onUpdate }: Props) {
  const [jd, setJd] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>('resume')

  const id = app?.id
  useEffect(() => {
    setJd(null)
    setError(null)
    setTab('resume')
    if (!id) return
    api.applications.readJobDescription(id).then(setJd, () => setJd(''))
  }, [id])
  useEffect(() => setNotes(app?.tracking.notes ?? ''), [id, app?.tracking.notes])

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  const has = (f: string) => app?.files.includes(f) ?? false

  return (
    <Drawer
      opened={app !== null}
      onClose={onClose}
      position="right"
      size="xl"
      title={
        app && (
          <Text fw={600}>
            {app.company} · {app.role}
          </Text>
        )
      }
      scrollAreaComponent={ScrollArea.Autosize}
    >
      {app && (
        <Stack gap="md">
          {app.jobTitle && <Text c="dimmed">{app.jobTitle}</Text>}
          <Group gap="xs">
            {has('resume.pdf') && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconFileTypePdf size={16} />}
                onClick={() => act(() => api.applications.openFile(app.id, 'resume.pdf'))}
              >
                Open resume
              </Button>
            )}
            {has('cover.pdf') && (
              <Button
                size="xs"
                variant="light"
                leftSection={<IconFileTypePdf size={16} />}
                onClick={() => act(() => api.applications.openFile(app.id, 'cover.pdf'))}
              >
                Open cover letter
              </Button>
            )}
            {app.jobUrl && (
              <Button
                size="xs"
                variant="default"
                component="a"
                href={app.jobUrl}
                target="_blank"
                rel="noreferrer"
                leftSection={<IconExternalLink size={16} />}
              >
                Job posting
              </Button>
            )}
            <Button
              size="xs"
              variant="default"
              leftSection={<IconFolder size={16} />}
              onClick={() => act(() => api.applications.reveal(app.id))}
            >
              Show in Finder
            </Button>
          </Group>

          {error && (
            <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
              {error}
            </Alert>
          )}

          <Group grow align="flex-start">
            <Select
              label="Status"
              data={APPLICATION_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))}
              value={app.tracking.status}
              allowDeselect={false}
              onChange={(v) => v && act(() => onUpdate({ status: v as ApplicationTracking['status'] }))}
            />
            <TextInput
              label="Applied on"
              type="date"
              value={app.tracking.appliedAt ?? ''}
              onChange={(e) => act(() => onUpdate({ appliedAt: e.currentTarget.value }))}
            />
          </Group>
          <TextInput
            label="Job posting URL"
            placeholder="https://…"
            defaultValue={app.tracking.jobUrl ?? app.jobUrl ?? ''}
            key={`url-${app.id}`}
            onBlur={(e) => {
              const v = e.currentTarget.value.trim()
              if (v !== (app.tracking.jobUrl ?? app.jobUrl ?? '')) void act(() => onUpdate({ jobUrl: v }))
            }}
          />
          <Textarea
            label="Notes"
            placeholder="Recruiter, referral, interview dates…"
            autosize
            minRows={3}
            value={notes}
            onChange={(e) => setNotes(e.currentTarget.value)}
            onBlur={() => notes !== app.tracking.notes && act(() => onUpdate({ notes }))}
          />

          <BuildBadge app={app} />

          <Tabs value={tab} onChange={setTab} keepMounted={false}>
            <Tabs.List>
              <Tabs.Tab value="resume">Resume ({app.resumePages.length})</Tabs.Tab>
              <Tabs.Tab value="cover" disabled={app.coverPages.length === 0}>
                Cover letter ({app.coverPages.length})
              </Tabs.Tab>
              <Tabs.Tab value="jd">Job description</Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="resume" pt="md">
              <Pages app={app} pages={app.resumePages} />
            </Tabs.Panel>
            <Tabs.Panel value="cover" pt="md">
              <Pages app={app} pages={app.coverPages} />
            </Tabs.Panel>
            <Tabs.Panel value="jd" pt="md">
              {jd === null ? (
                <Text c="dimmed">Loading…</Text>
              ) : jd === '' ? (
                <Text c="dimmed">No job-description.md in this folder.</Text>
              ) : (
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {jd}
                </Text>
              )}
            </Tabs.Panel>
          </Tabs>
          <Text size="xs" c="dimmed" ff="monospace">
            {app.id}/
          </Text>
        </Stack>
      )}
    </Drawer>
  )
}

function Pages({ app, pages }: { app: ApplicationRecord; pages: string[] }) {
  if (pages.length === 0) {
    return (
      <Text c="dimmed" size="sm">
        No page previews in this folder. The skill renders them when it builds the PDF; use{' '}
        <Anchor
          component="button"
          size="sm"
          onClick={() => void api.applications.openFile(app.id, 'resume.pdf').catch(() => {})}
        >
          Open resume
        </Anchor>{' '}
        instead.
      </Text>
    )
  }
  return (
    <Stack gap="md">
      {pages.map((p) => (
        <Image
          key={p}
          src={api.applications.fileUrl(app.id, p)}
          alt={p}
          radius="sm"
          style={{ border: '1px solid var(--mantine-color-default-border)' }}
        />
      ))}
    </Stack>
  )
}

/** Build result of the skill's `build-report.json`; `short` for table cells, details in the tooltip. */
export function BuildBadge({ app, short = false }: { app: ApplicationRecord; short?: boolean }) {
  const b = app.build
  const warnings = b.warnings > 0 ? `${b.warnings} warning${b.warnings === 1 ? '' : 's'}` : ''
  const [color, label, detail] =
    b.status === 'unknown'
      ? ['gray', short ? 'No report' : 'No build report', 'build-report.json is missing or unreadable']
      : b.status === 'pass'
        ? [
            'green',
            short ? 'ATS passed' : `ATS checks passed${warnings ? ` · ${warnings}` : ''}`,
            warnings || 'All checks passed'
          ]
        : [
            'red',
            short ? 'Build failed' : `Build failed${b.failed.length ? `: ${b.failed.join(', ')}` : ''}`,
            b.failed.join(', ') || 'The build did not pass'
          ]
  const badge = (
    <Badge variant="light" color={color}>
      {label}
    </Badge>
  )
  return short ? (
    <Tooltip label={detail} withArrow>
      {badge}
    </Tooltip>
  ) : (
    badge
  )
}
