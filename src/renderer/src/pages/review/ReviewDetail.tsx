import { useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  Collapse,
  Group,
  Image,
  List,
  Stack,
  Tabs,
  Text,
  Textarea,
  Title,
  Tooltip
} from '@mantine/core'
import { IconCheck, IconFileTypePdf, IconRefresh, IconTrash, IconWorld } from '@tabler/icons-react'
import { REVIEW_STATE_LABEL, type ReviewDetail, type ReviewOutcome } from '@shared/review-types'
import { api, errorText } from '../../api'
import { useNavigation } from '../../navigation'
import { Markdown } from '../tailor/Transcript'

interface Props {
  detail: ReviewDetail
  onDecided(next: ReviewDetail): void
  onReload(): void
}

/** One unattended result: notes, reframings to tick, gaps, verify report, page previews and the three decisions. */
export function ReviewDetailView({ detail: d, onDecided, onReload }: Props) {
  const { navigate } = useNavigation()
  const [ticked, setTicked] = useState<Set<string>>(new Set())
  const [answers, setAnswers] = useState('')
  const [rerunOpen, setRerunOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [rawReport, setRawReport] = useState(false)
  const [busy, setBusy] = useState<'approve' | 'rerun' | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stale, setStale] = useState<string | null>(null)
  const meta = REVIEW_STATE_LABEL[d.state]
  const decidable = d.state === 'unreviewed' || d.state === 'needs-attention'
  const ids = [...ticked]

  async function decide(kind: 'approve' | 'rerun' | 'discard', call: () => Promise<ReviewOutcome>) {
    setBusy(kind)
    setError(null)
    setStale(null)
    try {
      const out = await call()
      if (!out.ok) {
        if (out.error === 'stale') setStale(out.message)
        else setError(out.message)
        return
      }
      setTicked(new Set())
      setAnswers('')
      setRerunOpen(false)
      setConfirmDiscard(false)
      onDecided(out.detail)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const toggle = (id: string) =>
    setTicked((s) => {
      const next = new Set(s)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  return (
    <Stack gap="md">
      <Group justify="space-between" align="flex-start">
        <div>
          <Group gap="xs">
            <Title order={3}>{d.title}</Title>
            <Badge variant="light" color={meta.color}>
              {meta.label}
            </Badge>
          </Group>
          {d.reason && (
            <Text size="sm" c={d.state === 'needs-attention' ? 'orange' : 'dimmed'} mt={4}>
              {d.reason}
            </Text>
          )}
          <Text size="xs" c="dimmed" ff="monospace" mt={4}>
            {d.applicationId}/ · run {d.runId}
          </Text>
        </div>
        <Group gap="xs">
          {d.artifacts.some((a) => a.file === 'resume.pdf') && (
            <Button size="xs" variant="light" leftSection={<IconFileTypePdf size={16} />} onClick={() => void api.applications.openFile(d.applicationId, 'resume.pdf').catch((e) => setError(errorText(e)))}>
              Resume
            </Button>
          )}
          {d.artifacts.some((a) => a.file === 'cover.pdf') && (
            <Button size="xs" variant="light" color="grape" leftSection={<IconFileTypePdf size={16} />} onClick={() => void api.applications.openFile(d.applicationId, 'cover.pdf').catch((e) => setError(errorText(e)))}>
              Cover letter
            </Button>
          )}
          {d.jobUrl && (
            <Button size="xs" variant="default" leftSection={<IconWorld size={16} />} onClick={() => navigate('browser', { url: d.jobUrl! })}>
              Posting
            </Button>
          )}
        </Group>
      </Group>

      {stale && (
        <Alert color="orange" variant="light" title="This result changed">
          <Group justify="space-between">
            <Text size="sm">{stale}</Text>
            <Button size="compact-xs" onClick={onReload}>
              Reload
            </Button>
          </Group>
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      <Card withBorder radius="md" padding="md">
        <Group justify="space-between" mb="xs">
          <Title order={5}>Verify</Title>
          <Badge variant="light" color={d.build.status === 'pass' ? 'green' : d.build.status === 'fail' ? 'red' : 'gray'}>
            {d.build.status === 'pass' ? 'ATS checks passed' : d.build.status === 'fail' ? 'Build failed' : 'No build report'}
          </Badge>
        </Group>
        {d.build.failed.length > 0 && (
          <Text size="sm" c="red">
            Failed: {d.build.failed.join(', ')}
          </Text>
        )}
        {d.build.warnings > 0 && (
          <Text size="sm" c="dimmed">
            {d.build.warnings} warning{d.build.warnings === 1 ? '' : 's'}
          </Text>
        )}
        {d.verify.report && (
          <>
            <Button size="compact-xs" variant="subtle" mt={4} onClick={() => setRawReport((v) => !v)}>
              {rawReport ? 'Hide' : 'Show'} build-report.json
            </Button>
            <Collapse expanded={rawReport}>
              <Code block mt="xs" style={{ maxHeight: 300, overflow: 'auto' }}>
                {d.verify.report}
              </Code>
            </Collapse>
          </>
        )}
      </Card>

      <Card withBorder radius="md" padding="md">
        <Title order={5} mb="xs">
          Proposed reframings the run left out
        </Title>
        {d.parseWarning && (
          <Alert color="yellow" variant="light" py={6} mb="xs">
            <Text size="sm">{d.parseWarning}</Text>
          </Alert>
        )}
        {d.proposedReframings.length === 0 && !d.parseWarning && (
          <Text size="sm" c="dimmed">
            None: everything in the resume is a direct hit or a standing approval.
          </Text>
        )}
        <Stack gap="sm">
          {d.proposedReframings.map((r) => (
            <Group key={r.id} align="flex-start" wrap="nowrap" gap="sm">
              <Checkbox mt={4} checked={ticked.has(r.id)} disabled={!decidable} onChange={() => toggle(r.id)} aria-label={`Approve: ${r.wording}`} />
              <Stack gap={2} style={{ flex: 1 }}>
                {r.requirement && (
                  <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                    {r.requirement}
                  </Text>
                )}
                <Text size="sm">
                  <Text span c="dimmed">
                    Fact:{' '}
                  </Text>
                  {r.sourceFact}
                </Text>
                <Text size="sm">
                  <Text span c="dimmed">
                    Wording:{' '}
                  </Text>
                  <Text span fw={500}>
                    {r.wording}
                  </Text>
                </Text>
                {r.reason && (
                  <Text size="xs" c="dimmed">
                    Why unsure: {r.reason}
                  </Text>
                )}
              </Stack>
            </Group>
          ))}
        </Stack>
        {ids.length > 0 && (
          <Text size="xs" c="dimmed" mt="xs">
            Ticked reframings become standing approvals: later unattended runs may use them as written, for any job.
          </Text>
        )}
      </Card>

      {(d.usedApprovals.length > 0 || d.openGaps.length > 0) && (
        <Card withBorder radius="md" padding="md">
          {d.usedApprovals.length > 0 && (
            <>
              <Title order={5} mb="xs">
                Standing approvals used
              </Title>
              <List size="sm" spacing={4} mb="sm">
                {d.usedApprovals.map((u, i) => (
                  <List.Item key={i}>
                    <Text size="sm" span fw={500}>
                      {u.wording}
                    </Text>
                    <Text size="sm" span c="dimmed">
                      {' '}
                      ← {u.sourceFact}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </>
          )}
          {d.openGaps.length > 0 && (
            <>
              <Title order={5} mb="xs">
                Open gaps
              </Title>
              <List size="sm" spacing={2}>
                {d.openGaps.map((g) => (
                  <List.Item key={g}>{g}</List.Item>
                ))}
              </List>
            </>
          )}
        </Card>
      )}

      <Card withBorder radius="md" padding="md">
        <Tabs defaultValue="notes" keepMounted={false}>
          <Tabs.List>
            <Tabs.Tab value="notes">Review notes</Tabs.Tab>
            <Tabs.Tab value="resume" disabled={d.resumePages.length === 0}>
              Resume ({d.resumePages.length})
            </Tabs.Tab>
            <Tabs.Tab value="cover" disabled={d.coverPages.length === 0}>
              Cover letter ({d.coverPages.length})
            </Tabs.Tab>
          </Tabs.List>
          <Tabs.Panel value="notes" pt="md">
            {d.reviewNotes ? (
              <Markdown text={d.reviewNotes} />
            ) : (
              <Text size="sm" c="dimmed">
                {d.parseWarning?.startsWith('This result has no') ? 'No review-notes.md in this folder.' : 'The notes are too long to show here; open the folder.'}
              </Text>
            )}
          </Tabs.Panel>
          <Tabs.Panel value="resume" pt="md">
            <Pages id={d.applicationId} pages={d.resumePages} />
          </Tabs.Panel>
          <Tabs.Panel value="cover" pt="md">
            <Pages id={d.applicationId} pages={d.coverPages} />
          </Tabs.Panel>
        </Tabs>
      </Card>

      {decidable && (
        <Card withBorder radius="md" padding="md">
          <Stack gap="sm">
            <Group gap="xs">
              <Tooltip label={ids.length ? `Approve and save ${ids.length} reframing${ids.length === 1 ? '' : 's'} as standing approvals` : 'Approve as built; nothing is saved as a standing approval'}>
                <Button leftSection={<IconCheck size={16} />} loading={busy === 'approve'} disabled={busy !== null} onClick={() => decide('approve', () => api.review.approve({ applicationId: d.applicationId, revision: d.revision, approvedReframingIds: ids }))}>
                  Approve{ids.length ? ` (+${ids.length} standing)` : ''}
                </Button>
              </Tooltip>
              <Button variant="light" leftSection={<IconRefresh size={16} />} disabled={busy !== null} onClick={() => setRerunOpen((v) => !v)}>
                Re-run with my answers
              </Button>
              {!confirmDiscard ? (
                <Button variant="light" color="red" leftSection={<IconTrash size={16} />} disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>
                  Discard
                </Button>
              ) : (
                <Group gap="xs">
                  <Text size="sm">Archive this result (files are kept)?</Text>
                  <Button size="xs" color="red" loading={busy === 'discard'} onClick={() => decide('discard', () => api.review.discard({ applicationId: d.applicationId, revision: d.revision }))}>
                    Discard
                  </Button>
                  <Button size="xs" variant="subtle" onClick={() => setConfirmDiscard(false)}>
                    Keep
                  </Button>
                </Group>
              )}
            </Group>
            <Collapse expanded={rerunOpen}>
              <Stack gap="xs">
                <Textarea
                  label="Your decisions"
                  description="Sent to the run's own session. Ticked reframings above are sent as approved too."
                  autosize
                  minRows={3}
                  placeholder="e.g. Use R1 but say “contributed to”, not “led”. Drop R2. Mention the on-call rota."
                  value={answers}
                  onChange={(e) => setAnswers(e.currentTarget.value)}
                />
                <Group>
                  <Button size="xs" loading={busy === 'rerun'} disabled={busy !== null || (!answers.trim() && ids.length === 0)} onClick={() => decide('rerun', () => api.review.rerun({ applicationId: d.applicationId, revision: d.revision, answers, approvedReframingIds: ids }))}>
                    Send and rebuild
                  </Button>
                  <Text size="xs" c="dimmed">
                    The result comes back here as Unreviewed with a new revision.
                  </Text>
                </Group>
              </Stack>
            </Collapse>
          </Stack>
        </Card>
      )}
    </Stack>
  )
}

function Pages({ id, pages }: { id: string; pages: string[] }) {
  if (pages.length === 0)
    return (
      <Text c="dimmed" size="sm">
        No page previews in this folder.
      </Text>
    )
  return (
    <Stack gap="md">
      {pages.map((p) => (
        <Image key={p} src={api.applications.fileUrl(id, p)} alt={p} radius="sm" style={{ border: '1px solid var(--mantine-color-default-border)' }} />
      ))}
    </Stack>
  )
}
