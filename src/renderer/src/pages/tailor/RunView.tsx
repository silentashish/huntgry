import { useEffect, useMemo, useRef, useState } from 'react'
import { ActionIcon, Alert, Anchor, Button, Card, Loader, Menu, Stack, Text, Textarea, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconChevronDown, IconFileText, IconFolder, IconSend } from '@tabler/icons-react'
import { AGENT_LABEL, type RunSummary } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { api, errorText } from '../../api'
import { APPLY_HINT, applyBlocker } from '../../components/apply/blocker'
import { useApply } from '../../components/apply/useApply'
import { StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { RunMetrics } from '../../components/usage/RunMetrics'
import { AgentPill } from './parts'
import { runStatusLabel, shortWhen, STATUS_LABEL } from './status'
import { Transcript } from './Transcript'
import classes from './tailor.module.css'

interface Props {
  run: RunSummary
  events: unknown[]
  /** A bulk run whose reply waits for a free slot in the queue. */
  heldReply?: boolean
}

/** One run: its header (files, metrics), its conversation, and the reply dock. */
export function RunView({ run, events, heldReply = false }: Props) {
  const items = useMemo(() => buildTranscript(events, run.agent), [events, run.agent])
  const agent = AGENT_LABEL[run.agent]
  // A waiting run may have no process (Codex between turns, or one released to free a slot for the
  // queue; the reply resumes its session): "End" then just closes it.
  const canEnd = run.live || run.status === 'waiting'
  const { navigate } = useNavigation()
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  // Apply's own errors are shown next to its button, not at the end of the transcript (#63).
  const [applyError, setApplyError] = useState<string | null>(null)
  const applier = useApply(setApplyError)
  const [application, setApplication] = useState<Parameters<typeof applyBlocker>[0] | null>(null)
  const filesKey = run.outputFiles.join('\n')
  // Bumped when an application changes on disk or on the Review page, so an approval enables Apply here (#31).
  const [appsVersion, setAppsVersion] = useState(0)
  useEffect(() => api.on('applications:changed', () => setAppsVersion((v) => v + 1)), [])

  // The application record says whether Apply can work (Review state, resume.pdf on disk, a posting URL), the
  // same check as the Dashboard's; re-read when the run's files or status change, since the resume may be
  // rebuilt later, and when the application changes (an approval on the Review page).
  useEffect(() => {
    const folder = run.outputFolder
    setApplication(null)
    if (!folder) return
    let alive = true
    api.applications
      .get(folder)
      .then(
        (record) =>
          alive && setApplication({ files: record.files, jobUrl: record.jobUrl, tracking: { review: record.tracking.review } })
      )
      .catch(() => alive && setApplication({ files: run.outputFiles, jobUrl: null }))
    return () => {
      alive = false
    }
  }, [run.outputFolder, filesKey, run.status, appsVersion]) // eslint-disable-line react-hooks/exhaustive-deps

  // Block body: Chromium's scrollIntoView returns a Promise, which React would take for a cleanup function.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [items.length])

  const working = run.status === 'running'
  // A finished, stopped or failed run can be continued as long as the agent gave it a session.
  const canReply = !working && !sending && !heldReply && (run.live || run.sessionId !== null)

  async function act(fn: () => Promise<unknown>) {
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function send() {
    if (!reply.trim() || !canReply) return
    setSending(true)
    await act(async () => {
      await api.runner.reply(run.id, reply.trim())
      setReply('')
    })
    setSending(false)
  }

  const has = (f: string) => run.outputFiles.includes(f)
  const blocker = applyBlocker(application ?? { files: run.outputFiles, jobUrl: 'unknown' })
  const status = STATUS_LABEL[run.status]

  return (
    <Stack gap={16}>
      <Card withBorder radius="xl" padding={18}>
        <Stack gap={12}>
          <div className={classes.runHead}>
            <div className={classes.runHeadText}>
              <div className={classes.runTitleRow}>
                <h3 className={classes.runTitle}>{run.title}</h3>
                <AgentPill agent={run.agent} />
                <span data-testid="run-status" style={{ display: 'inline-flex' }}>
                  <StatusPill
                  tone={status.tone}
                  size="md"
                  dot={!working}
                  leftSection={working ? <Loader size={10} color="var(--hg-status-info)" /> : undefined}
                >
                  {runStatusLabel(run.status, run.agent)}
                  </StatusPill>
                </span>
              </div>
              <div className={classes.runMeta}>
                <span
                  className={classes.monoSm}
                  title={new Date(run.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                >
                  Started {shortWhen(run.createdAt)}
                </span>
                {run.outputFolder && (
                  <>
                    <span className={classes.monoSm} aria-hidden>
                      ·
                    </span>
                    <span className={`${classes.monoSm} ${classes.ellipsis}`} title={`${run.outputFolder}/ · ${run.outputFiles.join(', ')}`}>
                      {run.outputFolder}/ · {run.outputFiles.join(', ')}
                    </span>
                  </>
                )}
              </div>
            </div>
            {(run.outputFolder || canEnd) && (
              <div className={classes.runActions}>
                {run.outputFolder && (
                  <Tooltip label={blocker ?? APPLY_HINT} multiline maw={260}>
                    <Button
                      size="xs"
                      variant="light"
                      color="trail"
                      leftSection={<IconSend size={14} />}
                      loading={applier.busy}
                      disabled={blocker !== null || application === null}
                      onClick={() => {
                        setApplyError(null)
                        if (run.outputFolder) applier.apply({ id: run.outputFolder })
                      }}
                    >
                      Apply
                    </Button>
                  </Tooltip>
                )}
                {run.outputFolder && has('resume.pdf') && (
                  <Button
                    size="xs"
                    variant="default"
                    leftSection={<IconFileText size={14} />}
                    onClick={() => act(() => api.runner.openOutput(run.id, 'resume.pdf'))}
                  >
                    Resume
                  </Button>
                )}
                {run.outputFolder && has('cover.pdf') && (
                  <Button size="xs" variant="default" onClick={() => act(() => api.runner.openOutput(run.id, 'cover.pdf'))}>
                    Cover letter
                  </Button>
                )}
                {run.outputFolder && (
                  <Tooltip label="Show in Finder">
                    <ActionIcon variant="default" size="lg" aria-label="Show in Finder" onClick={() => act(() => api.runner.revealOutput(run.id))}>
                      <IconFolder size={16} />
                    </ActionIcon>
                  </Tooltip>
                )}
                {canEnd && (
                  <Menu position="bottom-end">
                    <Menu.Target>
                      <Button size="xs" variant="subtle" rightSection={<IconChevronDown size={14} />}>
                        End
                      </Button>
                    </Menu.Target>
                    <Menu.Dropdown>
                      <Menu.Item onClick={() => act(() => api.runner.finish(run.id))} disabled={working}>
                        Finish conversation
                      </Menu.Item>
                      {run.live && (
                        <Menu.Item color="red" onClick={() => act(() => api.runner.stop(run.id))}>
                          Stop {agent} now
                        </Menu.Item>
                      )}
                    </Menu.Dropdown>
                  </Menu>
                )}
              </div>
            )}
          </div>
          {run.outputFolder && (applyError || blocker) && (
            <Text size="xs" c={applyError ? 'var(--hg-status-danger)' : 'var(--hg-text-muted)'} data-testid="apply-reason">
              {applyError ?? `Apply: ${blocker}`}
            </Text>
          )}
          <div className={classes.metrics}>
            <RunMetrics run={run} />
          </div>
        </Stack>
      </Card>

      {run.error && run.status === 'failed' && (
        <Alert color="danger" icon={<IconAlertTriangle size={18} />} title={`${agent} stopped with an error`}>
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {run.error}
          </Text>
          {/* Set by the runner when the CLI rejected a flag (too old). */}
          {/Update Claude Code|Settings/.test(run.error) && (
            <Anchor component="button" size="sm" mt={4} onClick={() => navigate('settings')}>
              Open Settings
            </Anchor>
          )}
        </Alert>
      )}

      <Card withBorder radius="xl" padding={18}>
        <Stack gap={14}>
          <Transcript items={items} metrics={run.metrics} agent={run.agent} />
          {items.length === 0 && !working && (
            <Text size="sm" c="var(--hg-text-muted)">
              Nothing in this conversation yet.
            </Text>
          )}
          {working && (
            <div className={classes.working}>
              <Loader size="xs" type="dots" color="var(--hg-text-secondary)" />
              <span>{agent} is working…</span>
            </div>
          )}
          {heldReply && (
            <Alert color="warning" icon={<IconAlertTriangle size={18} />}>
              Your reply is held: the tailoring queue already has as many runs working as it allows. It is sent as soon
              as one of them finishes its turn (change "at a time" in the queue to allow more).
            </Alert>
          )}
        </Stack>
      </Card>

      {error && (
        <Alert color="danger" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Opaque dock so the transcript does not show through below the reply box. */}
      <div className={classes.dockWrap}>
        <div className={classes.dock}>
          <Textarea
            autosize
            minRows={2}
            maxRows={8}
            aria-label={`Reply to ${agent}`}
            placeholder={
              run.status === 'waiting'
                ? `Reply to ${agent}, e.g. "Approved" or what to change…`
                : run.live
                  ? `${agent} is working; you can reply when it asks.`
                  : run.sessionId
                    ? `Continue this conversation (${agent} resumes the session)…`
                    : 'This run cannot be continued.'
            }
            value={reply}
            disabled={!canReply}
            onChange={(e) => setReply(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <div className={classes.dockRow}>
            <span className={classes.monoXs}>⌘ + Enter to send</span>
            <span className={classes.spacer} />
            {canEnd && !working && (
              <Button size="xs" variant="subtle" onClick={() => act(() => api.runner.finish(run.id))}>
                Finish conversation
              </Button>
            )}
            <Button
              size="xs"
              variant="primary"
              leftSection={<IconSend size={14} />}
              onClick={send}
              loading={sending}
              disabled={!canReply || !reply.trim()}
            >
              Send
            </Button>
          </div>
        </div>
      </div>
      <div ref={bottom} />
      {applier.modal}
    </Stack>
  )
}
