import { useEffect, useState } from 'react'
import {
  ActionIcon,
  Alert,
  Anchor,
  Button,
  Drawer,
  Group,
  Image,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Tooltip,
  UnstyledButton
} from '@mantine/core'
import {
  IconArrowUpRight,
  IconCalendar,
  IconExternalLink,
  IconFileDescription,
  IconFileText,
  IconFolder,
  IconLink,
  IconSend
} from '@tabler/icons-react'
import { APPLICATION_STATUSES, type ApplicationRecord, type ApplicationTracking } from '@shared/applications-types'
import { AGENT_LABEL, type RunSummary } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { applyBlocker } from '../../components/apply/blocker'
import { runBadge } from '../../components/usage/format'
import { MonoLabel, StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { BuildBadge } from './BuildBadge'
import classes from './dashboard.module.css'
import { ReviewBadge } from './ReviewBadge'
import { STATUS_META } from './status'
import { shortDate } from './summary'

/** Kept here for the Board, which imports the badge from the drawer module. */
export { BuildBadge } from './BuildBadge'

interface Props {
  app: ApplicationRecord | null
  onClose(): void
  onUpdate(patch: Partial<ApplicationTracking>): Promise<void>
  /** Auto-apply: open the apply page in the in-app browser and fill it. */
  onApply(app: ApplicationRecord): void
  applying: boolean
}

/** One application: page previews, the saved job description, tracking and notes (Figma Dashboard — Application drawer). */
export function ApplicationDrawer({ app, onClose, onUpdate, onApply, applying }: Props) {
  const { navigate } = useNavigation()
  const [jd, setJd] = useState<string | null>(null)
  const [notes, setNotes] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<string | null>('resume')
  // The tailoring runs that built this application, with what they took (#44).
  const [runs, setRuns] = useState<RunSummary[]>([])

  const id = app?.id
  useEffect(() => {
    setJd(null)
    setError(null)
    setTab('resume')
    setRuns([])
    if (!id) return
    api.applications.readJobDescription(id).then(setJd, () => setJd(''))
    let alive = true
    api.runner.listRuns().then(
      (all) => alive && setRuns(all.filter((r) => r.outputFolder === id)),
      () => undefined
    )
    return () => {
      alive = false
    }
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
  const blocker = app ? applyBlocker(app) : null
  const reviewOpen = app?.tracking.review?.state === 'unreviewed' || app?.tracking.review?.state === 'needs-attention'

  return (
    <Drawer.Root opened={app !== null} onClose={onClose} position="right" size={600}>
      <Drawer.Overlay />
      <Drawer.Content>
        <Drawer.Header>
          {app && (
            <div className={classes.drawerHeader}>
              <div className={classes.drawerHeading}>
                <MonoLabel component="div" title={app.id}>
                  Application · {app.id}
                </MonoLabel>
                <Drawer.Title className={classes.drawerTitle}>
                  {app.company} · {app.role}
                </Drawer.Title>
                {app.jobTitle && app.jobTitle !== app.role && <p className={classes.drawerSubtitle}>{app.jobTitle}</p>}
              </div>
              <Drawer.CloseButton aria-label="Close" />
            </div>
          )}
        </Drawer.Header>
        <Drawer.Body>
          {app && (
            <Stack gap="md">
              <Group gap="xs">
                <Tooltip label={blocker ?? 'Fills the form and attaches resume.pdf; you review and submit'} multiline maw={260}>
                  <Button variant="primary" leftSection={<IconSend size={16} />} disabled={blocker !== null} loading={applying} onClick={() => onApply(app)}>
                    Apply in browser
                  </Button>
                </Tooltip>
                {has('resume.pdf') && (
                  <Button
                    variant="default"
                    leftSection={<IconFileText size={16} />}
                    aria-label="Open resume"
                    onClick={() => act(() => api.applications.openFile(app.id, 'resume.pdf'))}
                  >
                    Resume
                  </Button>
                )}
                {has('cover.pdf') && (
                  <Button
                    variant="default"
                    leftSection={<IconFileDescription size={16} />}
                    aria-label="Open cover letter"
                    onClick={() => act(() => api.applications.openFile(app.id, 'cover.pdf'))}
                  >
                    Cover letter
                  </Button>
                )}
                {app.jobUrl && (
                  <Button
                    variant="subtle"
                    leftSection={<IconExternalLink size={16} />}
                    aria-label="Job posting"
                    onClick={() => app.jobUrl && navigate('browser', { url: app.jobUrl })}
                  >
                    Posting
                  </Button>
                )}
                <Tooltip label="Show in Finder">
                  <ActionIcon variant="default" size="lg" aria-label="Show in Finder" onClick={() => act(() => api.applications.reveal(app.id))}>
                    <IconFolder size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>

              <Group gap="xs">
                <BuildBadge app={app} />
                <ReviewBadge app={app} />
                {reviewOpen && (
                  <UnstyledButton onClick={() => navigate('review', { applicationId: app.id })} style={{ display: 'inline-flex' }}>
                    <StatusPill size="md" variant="outline" leftSection={<IconArrowUpRight size={12} />}>
                      Open in Review
                    </StatusPill>
                  </UnstyledButton>
                )}
              </Group>

              {error && (
                <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
                  {error}
                </Alert>
              )}

              {runs.length > 0 && (
                <div className={classes.builtBy} data-testid="application-runs">
                  <MonoLabel component="div">Built by</MonoLabel>
                  {runs.map((r) => (
                    <div key={r.id} className={classes.runLine}>
                      <StatusPill tone="accent" variant="outline" dot>
                        {AGENT_LABEL[r.agent]}
                      </StatusPill>
                      <Anchor component="button" size="sm" c="var(--hg-accent-secondary)" onClick={() => navigate('tailor', { runId: r.id })}>
                        run of {shortDate(r.createdAt)} {new Date(r.createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </Anchor>
                      <MonoLabel>{runBadge(r) ?? ''}</MonoLabel>
                    </div>
                  ))}
                </div>
              )}

              <SimpleGrid cols={2} spacing="sm">
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
                  leftSection={<IconCalendar size={16} />}
                  value={app.tracking.appliedAt ?? ''}
                  onChange={(e) => act(() => onUpdate({ appliedAt: e.currentTarget.value }))}
                />
              </SimpleGrid>
              <TextInput
                label="Job posting URL"
                placeholder="https://…"
                leftSection={<IconLink size={16} />}
                styles={{ input: { fontFamily: 'var(--hg-font-mono)' } }}
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

              <div className={classes.previewCard}>
                <Tabs value={tab} onChange={setTab} keepMounted={false}>
                  <Tabs.List px="sm">
                    <Tabs.Tab value="resume">Resume ({app.resumePages.length})</Tabs.Tab>
                    <Tabs.Tab value="cover" disabled={app.coverPages.length === 0}>
                      Cover letter ({app.coverPages.length})
                    </Tabs.Tab>
                    <Tabs.Tab value="jd">Job description</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="resume" className={classes.previewPanel}>
                    <Pages app={app} pages={app.resumePages} />
                  </Tabs.Panel>
                  <Tabs.Panel value="cover" className={classes.previewPanel}>
                    <Pages app={app} pages={app.coverPages} />
                  </Tabs.Panel>
                  <Tabs.Panel value="jd" className={classes.previewPanel}>
                    {jd === null ? (
                      <Text c="dimmed" size="sm">
                        Loading…
                      </Text>
                    ) : jd === '' ? (
                      <Text c="dimmed" size="sm">
                        No job-description.md in this folder.
                      </Text>
                    ) : (
                      <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                        {jd}
                      </Text>
                    )}
                  </Tabs.Panel>
                </Tabs>
              </div>
            </Stack>
          )}
        </Drawer.Body>
      </Drawer.Content>
    </Drawer.Root>
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
    <div className={classes.pages}>
      {pages.map((p) => (
        <Image key={p} src={api.applications.fileUrl(app.id, p)} alt={p} className={classes.pageImage} />
      ))}
    </div>
  )
}
