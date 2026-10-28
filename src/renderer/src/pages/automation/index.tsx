import { useState } from 'react'
import { Alert, Button, Group, Select, Switch, Table, Text, Tooltip } from '@mantine/core'
import { IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconRobot } from '@tabler/icons-react'
import { AUTOMATION_STEP_LABEL, type AutomationCandidate, type AutomationState } from '@shared/automation-types'
import { api, errorText } from '../../api'
import { useAutomationLog, useAutomationSettings, useAutomationState } from '../../components/automation/useAutomation'
import { useNow } from '../../components/queue/usePipeline'
import { EmptyState, MonoLabel, PageHeader, ScoreRing, SectionCard, StatusPill } from '../../components/ui'
import { useNavigation, type PageParams } from '../../navigation'
import { Controls } from './Controls'
import { ReadyCard } from './ReadyCard'
import { countersText, firstReason, money, reasonsDetail, relativeTime, sectionsOf, sourceLabel, statusPill, STEP_TONE, titleOf } from './view'
import classes from './automation.module.css'

/**
 * Automation (#154): Huntgry prepares the jobs that match well, unattended, and stops before Submit. The page
 * shows the run (status, Pause / Resume, Run now, Stop, the run window), the controls, the jobs Ready to submit,
 * the ones that need you, every candidate with its step and reasons, and the step log.
 */
export function AutomationPage({ params: _params }: { params: PageParams['automation'] }) {
  const state = useAutomationState()
  const { settings, save } = useAutomationSettings()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const sections = sectionsOf(state)
  const pill = statusPill(state)

  async function act(name: string, fn: () => Promise<unknown>) {
    setBusy(name)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  const run = state?.run
  const paused = state?.paused || run?.status === 'paused'
  const header = (
    <PageHeader
      eyebrow="unattended · stops before submit"
      title="Automation"
      subtitle="Prepares applications for the jobs that match well (overnight, for example) and stops at the Submit button. You read the filled form and press Submit."
      actions={
        <>
          {paused ? (
            <Button variant="default" leftSection={<IconPlayerPlay size={16} />} loading={busy === 'resume'} onClick={() => void act('resume', () => api.automation.resume())}>
              Resume
            </Button>
          ) : (
            <Button variant="default" leftSection={<IconPlayerPause size={16} />} loading={busy === 'pause'} onClick={() => void act('pause', () => api.automation.pause())}>
              Pause
            </Button>
          )}
          {run && (
            <Button variant="default" leftSection={<IconPlayerStop size={16} />} loading={busy === 'stop'} onClick={() => void act('stop', () => api.automation.stop())}>
              Stop
            </Button>
          )}
          <Button variant="primary" leftSection={<IconRobot size={16} />} loading={busy === 'run'} disabled={!!run && run.status === 'running'} onClick={() => void act('run', () => api.automation.runNow())}>
            Run now
          </Button>
        </>
      }
    />
  )

  return (
    <div className={classes.page}>
      {header}

      <div className={classes.statusRow}>
        <StatusPill tone={pill.tone} dot={pill.live} size="md">
          <span role="status" aria-label={`Automation status: ${pill.label}`}>
            {pill.label}
          </span>
        </StatusPill>
        {state && (
          <Switch
            label="Run window"
            checked={state.enabled}
            disabled={busy === 'enable'}
            onChange={(e) => {
              const on = e.currentTarget.checked
              void act('enable', () => api.automation.setEnabled(on))
            }}
          />
        )}
        {state && settings && (
          <MonoLabel size="sm" tone="muted">
            {countersText(state, settings)}
          </MonoLabel>
        )}
      </div>
      <Text className={classes.note}>
        Huntgry must stay open (and awake) for the run window to work. The cost counts tailoring only; AI answers in forms are not counted.
      </Text>

      {error && (
        <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {settings && <Controls settings={settings} save={save} />}

      <section aria-label="Ready to submit">
        <SectionCard title="Ready to submit" badge={<StatusPill tone="accent">{String(sections.ready.length)}</StatusPill>} description="Filled forms waiting for you. Nothing was submitted.">
          {sections.ready.length === 0 ? (
            <Text size="sm" c="dimmed">
              No job is ready yet.
            </Text>
          ) : (
            <div className={classes.cards}>
              {sections.ready.map((c) => (
                <ReadyCard key={c.key} candidate={c} onError={setError} />
              ))}
            </div>
          )}
        </SectionCard>
      </section>

      {sections.needsYou.length > 0 && (
        <section aria-label="Needs you">
          <SectionCard title="Needs you" badge={<StatusPill tone="warning">{String(sections.needsYou.length)}</StatusPill>} description="A step failed. Nothing is retried on its own: retry it once, open the job, or dismiss it.">
            <ul className={classes.needsList}>
              {sections.needsYou.map((c) => (
                <NeedsYouRow key={c.key} candidate={c} onError={setError} />
              ))}
            </ul>
          </SectionCard>
        </section>
      )}

      <Candidates state={state} candidates={sections.others} />

      <StepLog state={state} />
    </div>
  )
}

function NeedsYouRow({ candidate: c, onError }: { candidate: AutomationCandidate; onError(message: string): void }) {
  const { navigate } = useNavigation()
  const call = (fn: () => Promise<unknown>) => void fn().catch((err: unknown) => onError(errorText(err)))
  return (
    <li className={classes.needsItem} aria-label={`Needs you: ${titleOf(c)}`}>
      <div className={classes.needsText}>
        <Text fw={600} size="sm">
          {titleOf(c)}
        </Text>
        <Text size="sm">
          <StatusPill tone="warning">{c.failedStep ? AUTOMATION_STEP_LABEL[c.failedStep] : 'Failed'}</StatusPill> {c.error}
        </Text>
      </div>
      <Group gap="xs">
        <Button size="xs" variant="default" onClick={() => call(() => api.automation.retry(c.key))}>
          Retry step
        </Button>
        {c.jobId && (
          <Button size="xs" variant="default" onClick={() => navigate('jobs', { openId: c.jobId })}>
            Open job
          </Button>
        )}
        <Button size="xs" variant="subtle" color="gray" onClick={() => call(() => api.automation.dismiss(c.key))}>
          Dismiss
        </Button>
      </Group>
    </li>
  )
}

function Candidates({ state, candidates }: { state: AutomationState | null; candidates: AutomationCandidate[] }) {
  const now = useNow(30_000)
  return (
    <SectionCard title="Candidates" description="Every job the last runs looked at: picked, being prepared, or skipped and why.">
      {candidates.length === 0 ? (
        <EmptyState
          compact
          tone="neutral"
          icon={<IconRobot size={32} stroke={1.5} />}
          title={state ? 'No candidates yet' : 'Loading'}
          description="Press Run now, or turn on the run window: Automation picks from your saved jobs and the Discover list."
        />
      ) : (
        <Table.ScrollContainer minWidth={760}>
          <Table aria-label="Candidates" fz="sm" verticalSpacing="xs">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Company</Table.Th>
                <Table.Th>Title</Table.Th>
                <Table.Th>Source</Table.Th>
                <Table.Th>Match</Table.Th>
                <Table.Th>Reasons</Table.Th>
                <Table.Th>Step</Table.Th>
                <Table.Th>Cost</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {candidates.map((c) => (
                <Table.Tr key={c.key}>
                  <Table.Td>{c.company}</Table.Td>
                  <Table.Td>{c.title}</Table.Td>
                  <Table.Td>{sourceLabel(c.source)}</Table.Td>
                  <Table.Td>{c.match ? <ScoreRing size="sm" value={c.match.score} aria-label={`Match ${c.match.score} of 100`} /> : '—'}</Table.Td>
                  <Table.Td>
                    <Tooltip label={<span style={{ whiteSpace: 'pre-line' }}>{reasonsDetail(c) || '—'}</span>} multiline maw={360} openDelay={300}>
                      <span className={classes.reason}>{firstReason(c)}</span>
                    </Tooltip>
                  </Table.Td>
                  <Table.Td>
                    <StatusPill tone={STEP_TONE[c.step]}>{AUTOMATION_STEP_LABEL[c.step]}</StatusPill>{' '}
                    <MonoLabel size="xs" tone="muted">
                      {relativeTime(c.updatedAt, now)}
                    </MonoLabel>
                  </Table.Td>
                  <Table.Td>{c.costUsd ? money(c.costUsd) : '—'}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
    </SectionCard>
  )
}

function StepLog({ state }: { state: AutomationState | null }) {
  const [key, setKey] = useState<string | null>(null)
  const log = useAutomationLog(key ?? undefined)
  const options = state ? Object.values(state.candidates).map((c) => ({ value: c.key, label: titleOf(c) || c.key })) : []
  return (
    <SectionCard
      title="Step log"
      description="Every step's start, result, skip and failure."
      actions={<Select aria-label="Filter the log by job" placeholder="All jobs" size="xs" clearable searchable data={options} value={key} onChange={setKey} w={260} />}
    >
      {log.length === 0 ? (
        <Text size="sm" c="dimmed">
          Nothing logged yet.
        </Text>
      ) : (
        <ul className={classes.log} aria-label="Step log entries">
          {log.map((e, i) => (
            <li key={`${e.at}-${i}`} className={classes.logItem}>
              <MonoLabel size="xs" tone="muted" title={new Date(e.at).toLocaleString()}>
                {new Date(e.at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
              </MonoLabel>
              <span className={classes.reason}>{e.title ?? (e.key ? e.key : 'Run')}</span>
              <span>{e.step === 'run' ? 'Run' : AUTOMATION_STEP_LABEL[e.step]}</span>
              <StatusPill tone={e.outcome === 'fail' ? 'danger' : e.outcome === 'ok' ? 'success' : e.outcome === 'skip' ? 'neutral' : 'info'}>{e.outcome}</StatusPill>
              <span>{e.message}</span>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  )
}
