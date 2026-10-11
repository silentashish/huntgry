import { useEffect, useId, useRef, useState } from 'react'
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
  Textarea,
  Tooltip
} from '@mantine/core'
import { IconAlertTriangle, IconCompass, IconCpu, IconSend, IconSparkles } from '@tabler/icons-react'
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
import { agentStatus } from '../../components/AgentPicker'
import { MonoLabel, StatusPill, toneStyle } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { planSummary } from './pipeline-plan'
import { selectionSummary } from './selection'
import classes from './jobs.module.css'

export type BulkMode = 'approve' | 'unattended'

interface Props {
  jobs: Job[]
  opened: boolean
  /** The mode the modal opens in (the selection bar's "Run unattended" opens it unattended). */
  initialMode?: BulkMode
  onClose(): void
  onQueued(result: EnqueueResult): void
  /** An unattended pipeline started. */
  onStarted(state: PipelineState): void
}

const DATE_STYLES = [
  { value: 'right', label: 'Right-aligned' },
  { value: 'inline', label: 'Inline (strict ATS)' }
]

/**
 * "Tailor N jobs": options shared by every run, then one call queues them
 * all. Two modes: approve each run (the queue as before) or run unattended
 * (#31: a plan step, then a pipeline that never waits for a reply and leaves
 * every result Unreviewed). Figma Jobs — Tailor all (unattended plan).
 */
export function BulkTailorModal({ jobs, opened, initialMode, onClose, onQueued, onStarted }: Props) {
  const { navigate } = useNavigation()
  const [mode, setMode] = useState<BulkMode>('approve')
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
    if (initialMode) setMode(initialMode)
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
  }, [opened, initialMode])

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
  const jobsWord = `job${summary.total === 1 ? '' : 's'}`

  return (
    <Modal.Root opened={opened} onClose={onClose} size={720}>
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header className={classes.modalHeader}>
          <Modal.Title className={classes.modalTitle}>
            Tailor {summary.total} {jobsWord}
          </Modal.Title>
          <SegmentedControl
            value={mode}
            onChange={(v) => setMode(v as BulkMode)}
            aria-label="How the runs go"
            data={[
              {
                value: 'approve',
                label: (
                  <span className={classes.modeIcon}>
                    <IconSend size={14} aria-hidden />
                    Approve each run
                  </span>
                )
              },
              {
                value: 'unattended',
                label: (
                  <span className={classes.modeIcon}>
                    <IconCpu size={14} aria-hidden />
                    Run unattended
                  </span>
                )
              }
            ]}
          />
          <Modal.CloseButton aria-label="Close" />
        </Modal.Header>
        <Modal.Body className={classes.modalBody}>
          <Stack gap="md">
            <div className={classes.notice} style={toneStyle('trail')}>
              <span className={classes.noticeIcon}>
                <IconSparkles size={18} />
              </span>
              <p>
                {unattended
                  ? `Huntgry starts one ${AGENT_LABEL[agent]} run per job, a few at a time, and nobody has to answer. ${UNATTENDED_EXPLANATION}`
                  : `Huntgry starts one ${AGENT_LABEL[agent]} run per job, a few at a time, on the Tailor page. Each run stops after the gap analysis and waits for you to approve it there before the PDFs are built.`}
              </p>
            </div>

            {environment && problem && (
              <Alert
                color={blocking ? 'danger' : 'warning'}
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
              <Alert color="info" variant="light">
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

            <Group gap={12} align="flex-start" wrap="nowrap">
              <Textarea
                style={{ flex: 1 }}
                label={`Notes for ${AGENT_LABEL[agent]} (every job)`}
                placeholder="Optional: angle, seniority, stack to emphasise…"
                autosize
                minRows={1}
                maxRows={6}
                value={notes}
                onChange={(e) => setNotes(e.currentTarget.value)}
              />
              <Select
                label="Runs at once"
                w={110}
                allowDeselect={false}
                value={concurrency}
                onChange={(v) => {
                  if (!v) return
                  concurrencyTouched.current = true
                  setConcurrency(v)
                }}
                data={Array.from({ length: MAX_CONCURRENCY }, (_, i) => String(i + 1))}
              />
              <Select
                label="Date style"
                w={170}
                allowDeselect={false}
                value={dateStyle}
                onChange={(v) => v && setDateStyle(v as 'inline' | 'right')}
                data={DATE_STYLES}
              />
            </Group>

            <Group gap={8} justify="space-between" wrap="wrap">
              <AgentChoice environment={environment} value={agent} onChange={setPicked} />
              <Switch label="Cover letters" checked={coverLetter} onChange={(e) => setCoverLetter(e.currentTarget.checked)} />
            </Group>

            {unattended && (
              <>
                <Group gap={12} align="flex-start" wrap="nowrap">
                  <Select
                    style={{ flex: 1 }}
                    label="Fallback agent"
                    description={`Takes over jobs not started yet when ${AGENT_LABEL[agent]} hits its usage limit`}
                    inputWrapperOrder={['label', 'input', 'description', 'error']}
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
                    className={classes.mono}
                    hideControls
                    label="Max cost ($)"
                    w={120}
                    min={1}
                    max={MAX_BUDGET_USD}
                    decimalScale={2}
                    placeholder="No cap"
                    value={maxCostUsd}
                    onChange={setMaxCostUsd}
                  />
                  <NumberInput
                    className={classes.mono}
                    hideControls
                    label="Max jobs"
                    w={100}
                    min={1}
                    max={MAX_ENQUEUE}
                    allowDecimal={false}
                    placeholder="No cap"
                    value={maxJobs}
                    onChange={setMaxJobs}
                  />
                  <NumberInput
                    className={classes.mono}
                    hideControls
                    label="Stall (min)"
                    w={100}
                    min={MIN_STALL_MINUTES}
                    max={MAX_STALL_MINUTES}
                    allowDecimal={false}
                    value={stallMinutes}
                    onChange={setStallMinutes}
                  />
                </Group>
                <p className={classes.hint}>
                  Max cost {agent === 'claude' ? 'covers Claude runs only' : 'counts Claude runs only'}. Max jobs stops
                  starting new jobs after that many. Stall kills and retries a run that has been silent that long.
                </p>
                <div className={classes.switches}>
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
                </div>
                {fallbackBlocked && fallbackStatus && (
                  <Alert color="danger" variant="light" title={`${AGENT_LABEL[fallback!]} cannot be the fallback yet`}>
                    <Text size="sm">{fallbackStatus.problems[0]}</Text>
                  </Alert>
                )}
                <p className={classes.hint}>
                  The Mac is kept awake while the pipeline has work (the display may sleep). On battery, closing the lid
                  still puts it to sleep: keep it plugged in and open.
                </p>
              </>
            )}

            {unattended && plan && <PlanView plan={plan} onSettings={() => navigate('settings')} />}

            {tooMany && (
              <Alert color="warning" variant="light">
                Huntgry queues at most {MAX_ENQUEUE} jobs at a time. {jobs.length} are selected: narrow the list or untick
                some, then tailor the rest afterwards.
              </Alert>
            )}

            {error && (
              <Alert color="danger" variant="light">
                {error}
              </Alert>
            )}

            <div className={classes.footer}>
              <p className={classes.hint}>{!unattended && 'Each job’s agent can still be changed in the queue until it starts.'}</p>
              <Button variant="subtle" onClick={onClose}>
                Cancel
              </Button>
              {!unattended && (
                <Button
                  variant="primary"
                  leftSection={<IconSparkles size={16} />}
                  loading={busy}
                  disabled={jobs.length === 0 || tooMany || blocking}
                  onClick={confirm}
                >
                  Tailor {summary.total} {jobsWord}
                </Button>
              )}
              {unattended && !plan && (
                <Button
                  variant="primary"
                  leftSection={<IconCompass size={16} />}
                  loading={busy}
                  disabled={jobs.length === 0 || tooMany || blocking || fallbackBlocked}
                  onClick={planIt}
                >
                  Continue
                </Button>
              )}
              {unattended && plan && (
                <Button
                  variant="primary"
                  loading={busy}
                  leftSection={<IconCpu size={16} />}
                  disabled={plan.blockers.length > 0 || plan.ready.length === 0}
                  onClick={startIt}
                >
                  Start unattended ({plan.ready.length})
                </Button>
              )}
            </div>
          </Stack>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  )
}

/**
 * Claude / Codex / Antigravity as radio chips (Figma Tailor all, Agent row). An agent whose CLI or
 * skill is missing is marked, with the reason on hover; it can still be picked, so the modal can say
 * what to fix, and starting stays blocked until then (same rules as the shared AgentPicker).
 */
function AgentChoice({
  environment,
  value,
  onChange
}: {
  environment: RunnerEnvironment | null
  value: AgentId
  onChange(agent: AgentId): void
}) {
  // Native radios in one named group: one tab stop, arrow keys move the choice.
  const group = useId()
  return (
    <div className={classes.agents} role="radiogroup" aria-labelledby={`${group}-label`}>
      <span className={classes.agentsLabel} id={`${group}-label`}>
        Agent
      </span>
      {AGENT_IDS.map((id) => {
        const s = environment?.agents.find((a) => a.id === id)
        const unready = !!s && !s.ready
        const chip = (
          <label key={id} className={classes.agent} data-checked={id === value || undefined} data-unready={unready || undefined}>
            <input
              type="radio"
              className={classes.agentInput}
              name={group}
              value={id}
              checked={id === value}
              onChange={() => onChange(id)}
              aria-label={`${AGENT_LABEL[id]}${id === environment?.defaultAgent ? ' (default)' : ''}${unready ? ': not available' : ''}`}
            />
            <span className={classes.radio} aria-hidden />
            <span aria-hidden>{AGENT_LABEL[id]}</span>
            {id === environment?.defaultAgent && (
              <span aria-hidden>
                <MonoLabel size="xs">default</MonoLabel>
              </span>
            )}
            {unready && (
              <span className={classes.agentWarn} aria-hidden>
                <IconAlertTriangle size={14} />
              </span>
            )}
          </label>
        )
        return unready ? (
          <Tooltip key={id} label={s.problems[0]} multiline w={300} withArrow>
            {chip}
          </Tooltip>
        ) : (
          chip
        )
      })}
    </div>
  )
}

/** The plan step: what runs, what is skipped and why, the estimate, and anything that blocks the start. */
function PlanView({ plan, onSettings }: { plan: PipelinePlan; onSettings(): void }) {
  const s = planSummary(plan)
  const state =
    plan.blockers.length > 0
      ? ({ tone: 'danger', label: 'blocked' } as const)
      : plan.ready.length === 0
        ? ({ tone: 'warning', label: 'nothing to run' } as const)
        : ({ tone: 'trail', label: 'ready' } as const)
  return (
    <section className={classes.plan} aria-labelledby="bulk-plan-title">
      <div className={classes.planHeader}>
        <IconCompass size={16} aria-hidden />
        <h3 className={classes.planTitle} id="bulk-plan-title">
          Plan
        </h3>
        <StatusPill tone={state.tone} dot>
          {state.label}
        </StatusPill>
      </div>
      <p className={classes.planText}>
        {s.ready} {s.estimate} {s.cost}
      </p>
      {plan.blockers.length > 0 && (
        <>
          <ul className={classes.planList} style={toneStyle('danger')}>
            {plan.blockers.map((b) => (
              <li key={b}>
                <IconAlertTriangle size={14} aria-hidden />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <Anchor component="button" size="sm" onClick={onSettings} style={{ alignSelf: 'flex-start' }}>
            Open Settings
          </Anchor>
        </>
      )}
      {s.skipped && (
        <ul className={classes.planList} style={toneStyle('warning')} aria-label={s.skipped}>
          {plan.skipped.map((k) => (
            <li key={k.jobId}>
              <IconAlertTriangle size={14} aria-hidden />
              <span>
                Skipped: {k.title} — {k.reason}
              </span>
            </li>
          ))}
        </ul>
      )}
      {plan.warnings.length > 0 && (
        <ul className={classes.planList} style={toneStyle('warning')}>
          {plan.warnings.map((w) => (
            <li key={w}>
              <IconAlertTriangle size={14} aria-hidden />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
