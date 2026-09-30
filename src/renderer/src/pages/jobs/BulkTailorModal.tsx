import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Anchor,
  Button,
  Group,
  List,
  Modal,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea
} from '@mantine/core'
import type { Job } from '@shared/jobs-types'
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_ENQUEUE, type EnqueueResult } from '@shared/queue-types'
import { AGENT_LABEL, DEFAULT_AGENT, type AgentId, type RunnerEnvironment } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { AgentPicker, agentStatus } from '../../components/AgentPicker'
import { useNavigation } from '../../navigation'
import { selectionSummary } from './selection'

interface Props {
  jobs: Job[]
  opened: boolean
  onClose(): void
  onQueued(result: EnqueueResult): void
}

/** "Tailor N jobs": options shared by every run, then one call queues them all. */
export function BulkTailorModal({ jobs, opened, onClose, onQueued }: Props) {
  const { navigate } = useNavigation()
  const [coverLetter, setCoverLetter] = useState(true)
  const [dateStyle, setDateStyle] = useState<'inline' | 'right'>('right')
  const [notes, setNotes] = useState('')
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY))
  const [environment, setEnvironment] = useState<RunnerEnvironment | null>(null)
  /** Agent for every job of this request; the default agent until the user picks one. */
  const [picked, setPicked] = useState<AgentId | null>(null)
  const agent = picked ?? environment?.defaultAgent ?? DEFAULT_AGENT
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The user picked "Runs at once" in this opening; the queue's current value must not overwrite it. */
  const concurrencyTouched = useRef(false)

  useEffect(() => {
    if (!opened) return
    let live = true
    concurrencyTouched.current = false
    setError(null)
    api.runner.environment().then(
      (env) => live && setEnvironment(env),
      () => live && setEnvironment(null)
    )
    api.queue.state().then(
      (s) => live && !concurrencyTouched.current && setConcurrency(String(s.concurrency)),
      () => undefined
    )
    // A late answer for a closed (or reopened) modal is ignored.
    return () => {
      live = false
    }
  }, [opened])

  const summary = selectionSummary(jobs)
  const status = agentStatus(environment, agent)
  const blocking = !!status && !status.ready
  const problem = blocking ? status.problems[0] : environment?.sharedProblems[0]
  // The main process accepts at most MAX_ENQUEUE ids per request.
  const tooMany = jobs.length > MAX_ENQUEUE

  async function confirm() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.queue.enqueue({
        jobIds: jobs.map((j) => j.id),
        options: { coverLetter, dateStyle, notes: notes.trim() || undefined },
        concurrency: Number(concurrency),
        agent
      })
      onQueued(result)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal opened={opened} onClose={onClose} title={`Tailor ${summary.total} job${summary.total === 1 ? '' : 's'}`} size="lg">
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Huntgry starts one {AGENT_LABEL[agent]} run per job, a few at a time, on the Tailor page. Each run stops after the gap
          analysis and waits for you to approve it there before the PDFs are built.
        </Text>

        {environment && problem && (
          <Alert
            color={blocking ? 'red' : 'yellow'}
            variant="light"
            title={blocking ? `${AGENT_LABEL[agent]} cannot run yet` : 'Some dependencies are missing'}
          >
            <Text size="sm">{problem}</Text>
            <Anchor component="button" size="sm" mt={4} onClick={() => navigate('settings')}>
              Open Settings
            </Anchor>
          </Alert>
        )}

        {(summary.summaryOnly > 0 || summary.alreadyTailored > 0) && (
          <Alert color="blue" variant="light">
            <List size="sm" spacing={4}>
              {summary.summaryOnly > 0 && (
                <List.Item>
                  {summary.summaryOnly} of {summary.total} have only the board's summary. Huntgry reads the employer's
                  posting first and skips the job if it cannot
                  {summary.unreadable > 0 ? ` (${summary.unreadable} from Indeed will be skipped: paste those instead)` : ''}.
                </List.Item>
              )}
              {summary.alreadyTailored > 0 && (
                <List.Item>
                  {summary.alreadyTailored} {summary.alreadyTailored === 1 ? 'was' : 'were'} tailored before and will get
                  a new run.
                </List.Item>
              )}
            </List>
          </Alert>
        )}

        <Textarea
          label={`Notes for ${AGENT_LABEL[agent]} (every job)`}
          placeholder="Optional: angle, seniority, stack to emphasise…"
          autosize
          minRows={2}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <Group gap="xl" align="flex-end">
          <Switch label="Cover letters" checked={coverLetter} onChange={(e) => setCoverLetter(e.currentTarget.checked)} />
          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Date style
            </Text>
            <SegmentedControl
              size="xs"
              value={dateStyle}
              onChange={(v) => setDateStyle(v as 'inline' | 'right')}
              data={[
                { value: 'right', label: 'Right-aligned' },
                { value: 'inline', label: 'Inline (strict ATS)' }
              ]}
            />
          </Stack>
          <Select
            label="Runs at once"
            w={120}
            allowDeselect={false}
            value={concurrency}
            onChange={(v) => {
              if (!v) return
              concurrencyTouched.current = true
              setConcurrency(v)
            }}
            data={Array.from({ length: MAX_CONCURRENCY }, (_, i) => String(i + 1))}
          />
        </Group>
        <AgentPicker environment={environment} value={agent} onChange={setPicked} />
        <Text size="xs" c="dimmed" mt={-8}>
          Each job's agent can still be changed in the queue until it starts.
        </Text>

        {tooMany && (
          <Alert color="orange" variant="light">
            Huntgry queues at most {MAX_ENQUEUE} jobs at a time. {jobs.length} are selected: narrow the list or untick
            some, then tailor the rest afterwards.
          </Alert>
        )}

        {error && (
          <Alert color="red" variant="light">
            {error}
          </Alert>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={jobs.length === 0 || tooMany || blocking} onClick={confirm}>
            Tailor {summary.total} job{summary.total === 1 ? '' : 's'}
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
