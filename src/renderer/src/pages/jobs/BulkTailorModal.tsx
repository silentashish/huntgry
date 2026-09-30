import { useEffect, useRef, useState } from 'react'
import {
  Alert,
  Anchor,
  Button,
  Group,
  List,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Textarea
} from '@mantine/core'
import { IconAlertTriangle, IconRobot } from '@tabler/icons-react'
import type { Job } from '@shared/jobs-types'
import {
  DEFAULT_STALL_MINUTES,
  MAX_BUDGET_USD,
  MAX_STALL_MINUTES,
  MIN_STALL_MINUTES,
  UNATTENDED_EXPLANATION,
  type PipelinePlan,
  type PipelineStartInput,
  type PipelineState
} from '@shared/pipeline-types'
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY, MAX_ENQUEUE, type EnqueueResult } from '@shared/queue-types'
import { AGENT_IDS, AGENT_LABEL, DEFAULT_AGENT, type AgentId, type RunnerEnvironment } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { AgentPicker, agentStatus } from '../../components/AgentPicker'
import { useNavigation } from '../../navigation'
import { planSummary } from './pipeline-plan'
import { selectionSummary } from './selection'

interface Props {
  jobs: Job[]
  opened: boolean
  onClose(): void
  onQueued(result: EnqueueResult): void
  /** An unattended pipeline started. */
  onStarted(state: PipelineState): void
}

type Mode = 'approve' | 'unattended'

/**
 * "Tailor N jobs": options shared by every run, then one call queues them
 * all. Two modes: approve each run (the queue as before) or run unattended
 * (#31: a plan step, then a pipeline that never waits for a reply and leaves
 * every result Unreviewed).
 */
export function BulkTailorModal({ jobs, opened, onClose, onQueued, onStarted }: Props) {
  const { navigate } = useNavigation()
  const [mode, setMode] = useState<Mode>('approve')
  const [coverLetter, setCoverLetter] = useState(true)
  const [dateStyle, setDateStyle] = useState<'inline' | 'right'>('right')
  const [notes, setNotes] = useState('')
  const [concurrency, setConcurrency] = useState(String(DEFAULT_CONCURRENCY))
  const [environment, setEnvironment] = useState<RunnerEnvironment | null>(null)
  /** Agent for every job of this request; the default agent until the user picks one. */
  const [picked, setPicked] = useState<AgentId | null>(null)
  const agent = picked ?? environment?.defaultAgent ?? DEFAULT_AGENT
  const [fallback, setFallback] = useState<AgentId | null>(null)
  const [maxCostUsd, setMaxCostUsd] = useState<number | string>('')
  const [maxJobs, setMaxJobs] = useState<number | string>('')
  const [resumeAfterRestart, setResumeAfterRestart] = useState(true)
  const [skipTailored, setSkipTailored] = useState(true)
  const [stallMinutes, setStallMinutes] = useState<number | string>(DEFAULT_STALL_MINUTES)
  const [plan, setPlan] = useState<PipelinePlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The user picked "Runs at once" in this opening; the queue's current value must not overwrite it. */
  const concurrencyTouched = useRef(false)

  useEffect(() => {
    if (!opened) return
    let live = true
    concurrencyTouched.current = false
    setError(null)
    setPlan(null)
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

  // The plan describes one set of choices: any change means planning again.
  useEffect(() => {
    setPlan(null)
  }, [jobs, agent, fallback, concurrency, maxCostUsd, maxJobs, skipTailored, coverLetter, dateStyle, notes, stallMinutes, mode])

  const summary = selectionSummary(jobs)
  const status = agentStatus(environment, agent)
  const blocking = !!status && !status.ready
  const problem = blocking ? status.problems[0] : environment?.sharedProblems[0]
  // The main process accepts at most MAX_ENQUEUE ids per request.
  const tooMany = jobs.length > MAX_ENQUEUE
  const unattended = mode === 'unattended'
  const fallbackStatus = fallback ? agentStatus(environment, fallback) : null
  const fallbackBlocked = !!fallbackStatus && !fallbackStatus.ready
  const readyAgents = AGENT_IDS.filter((id) => id !== agent && (agentStatus(environment, id)?.ready ?? true))

  function pipelineInput(): PipelineStartInput {
    return {
      jobIds: jobs.map((j) => j.id),
      options: { coverLetter, dateStyle, notes: notes.trim() || undefined },
      agent,
      fallbackAgent: fallback ?? undefined,
      concurrency: Number(concurrency),
      budget:
        maxCostUsd !== '' || maxJobs !== ''
          ? {
              ...(maxCostUsd !== '' ? { maxCostUsd: Number(maxCostUsd) } : {}),
              ...(maxJobs !== '' ? { maxJobs: Number(maxJobs) } : {})
            }
          : undefined,
      resumeAfterRestart,
      skipTailored,
      stallMinutes: Number(stallMinutes) || DEFAULT_STALL_MINUTES
    }
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const confirm = () =>
    run(async () => {
      const result = await api.queue.enqueue({
        jobIds: jobs.map((j) => j.id),
        options: { coverLetter, dateStyle, notes: notes.trim() || undefined },
        concurrency: Number(concurrency),
        agent
      })
      onQueued(result)
    })

  const planIt = () => run(async () => setPlan(await api.pipeline.plan(pipelineInput())))
  const startIt = () => run(async () => onStarted(await api.pipeline.start(pipelineInput())))

  return (
    <Modal opened={opened} onClose={onClose} title={`Tailor ${summary.total} job${summary.total === 1 ? '' : 's'}`} size="lg">
      <Stack gap="md">
        <SegmentedControl
          value={mode}
          onChange={(v) => setMode(v as Mode)}
          data={[
            { value: 'approve', label: 'Approve each run' },
            { value: 'unattended', label: 'Run unattended' }
          ]}
        />
        <Text size="sm" c="dimmed">
          {unattended
            ? `Huntgry starts one ${AGENT_LABEL[agent]} run per job, a few at a time, and nobody has to answer. ${UNATTENDED_EXPLANATION}`
            : `Huntgry starts one ${AGENT_LABEL[agent]} run per job, a few at a time, on the Tailor page. Each run stops after the gap analysis and waits for you to approve it there before the PDFs are built.`}
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

        {!unattended && (summary.summaryOnly > 0 || summary.alreadyTailored > 0) && (
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
        {!unattended && (
          <Text size="xs" c="dimmed" mt={-8}>
            Each job's agent can still be changed in the queue until it starts.
          </Text>
        )}

        {unattended && (
          <Stack gap="sm">
            <Group gap="md" align="flex-end">
              <Select
                label="Fallback agent"
                description="Takes over the jobs not started yet when the agent hits its usage limit"
                w={220}
                clearable
                placeholder="None (wait for the reset)"
                value={fallback}
                onChange={(v) => setFallback((v as AgentId) ?? null)}
                data={AGENT_IDS.filter((id) => id !== agent).map((id) => ({
                  value: id,
                  label: AGENT_LABEL[id],
                  disabled: !readyAgents.includes(id)
                }))}
              />
              <NumberInput
                label="Max cost ($)"
                description={agent === 'claude' ? 'Claude runs only' : 'Counts Claude runs only'}
                w={140}
                min={1}
                max={MAX_BUDGET_USD}
                decimalScale={2}
                placeholder="No cap"
                value={maxCostUsd}
                onChange={setMaxCostUsd}
              />
              <NumberInput
                label="Max jobs"
                description="Stops starting new jobs after"
                w={130}
                min={1}
                max={MAX_ENQUEUE}
                allowDecimal={false}
                placeholder="No cap"
                value={maxJobs}
                onChange={setMaxJobs}
              />
              <NumberInput
                label="Stall (min)"
                description="Kill and retry a silent run after"
                w={120}
                min={MIN_STALL_MINUTES}
                max={MAX_STALL_MINUTES}
                allowDecimal={false}
                value={stallMinutes}
                onChange={setStallMinutes}
              />
            </Group>
            <Group gap="xl">
              <Switch
                label="Resume after a restart"
                checked={resumeAfterRestart}
                onChange={(e) => setResumeAfterRestart(e.currentTarget.checked)}
              />
              <Switch
                label="Skip jobs tailored before"
                checked={skipTailored}
                onChange={(e) => setSkipTailored(e.currentTarget.checked)}
              />
            </Group>
            {fallbackBlocked && fallbackStatus && (
              <Alert color="red" variant="light" title={`${AGENT_LABEL[fallback!]} cannot be the fallback yet`}>
                <Text size="sm">{fallbackStatus.problems[0]}</Text>
              </Alert>
            )}
            <Text size="xs" c="dimmed">
              The Mac is kept awake while the pipeline has work (the display may sleep). On battery, closing the lid
              still puts it to sleep: keep it plugged in and open.
            </Text>
          </Stack>
        )}

        {unattended && plan && <PlanView plan={plan} onSettings={() => navigate('settings')} />}

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
          {!unattended && (
            <Button loading={busy} disabled={jobs.length === 0 || tooMany || blocking} onClick={confirm}>
              Tailor {summary.total} job{summary.total === 1 ? '' : 's'}
            </Button>
          )}
          {unattended && !plan && (
            <Button loading={busy} disabled={jobs.length === 0 || tooMany || blocking || fallbackBlocked} onClick={planIt}>
              Continue
            </Button>
          )}
          {unattended && plan && (
            <Button
              loading={busy}
              leftSection={<IconRobot size={16} />}
              disabled={plan.blockers.length > 0 || plan.ready.length === 0}
              onClick={startIt}
            >
              Start unattended ({plan.ready.length})
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  )
}

/** The plan step: what runs, what is skipped and why, the estimate, and anything that blocks the start. */
function PlanView({ plan, onSettings }: { plan: PipelinePlan; onSettings(): void }) {
  const s = planSummary(plan)
  return (
    <Stack gap="xs">
      {plan.blockers.length > 0 && (
        <Alert color="red" variant="light" title="Cannot start yet">
          <List size="sm" spacing={4}>
            {plan.blockers.map((b) => (
              <List.Item key={b}>{b}</List.Item>
            ))}
          </List>
          <Anchor component="button" size="sm" mt={4} onClick={onSettings}>
            Open Settings
          </Anchor>
        </Alert>
      )}
      <Alert color={plan.ready.length > 0 ? 'blue' : 'orange'} variant="light" title="Plan">
        <Stack gap={4}>
          <Text size="sm">
            {s.ready} {s.estimate}
          </Text>
          {s.cost && (
            <Text size="sm" c="dimmed">
              {s.cost}
            </Text>
          )}
          {s.skipped && (
            <>
              <Text size="sm">{s.skipped}</Text>
              <List size="sm" spacing={2}>
                {plan.skipped.map((k) => (
                  <List.Item key={k.jobId}>
                    <Text size="sm" span fw={500}>
                      {k.title}
                    </Text>
                    <Text size="sm" span c="dimmed">
                      {' '}
                      · {k.reason}
                    </Text>
                  </List.Item>
                ))}
              </List>
            </>
          )}
        </Stack>
      </Alert>
      {plan.warnings.length > 0 && (
        <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
          <List size="sm" spacing={2}>
            {plan.warnings.map((w) => (
              <List.Item key={w}>{w}</List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  )
}
