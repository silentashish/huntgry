import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Kbd,
  Loader,
  Menu,
  Stack,
  Text,
  Textarea,
  Title
} from '@mantine/core'
import { IconFileTypePdf, IconFolder, IconPlayerStop, IconSend } from '@tabler/icons-react'
import { AGENT_LABEL, type RunSummary } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { api, errorText } from '../../api'
import { useApply } from '../../components/apply/useApply'
import { useNavigation } from '../../navigation'
import { AGENT_COLOR, runCost, runStatusLabel, STATUS_LABEL } from './status'
import { Transcript } from './Transcript'

interface Props {
  run: RunSummary
  events: unknown[]
  /** A bulk run whose reply waits for a free slot in the queue. */
  heldReply?: boolean
}

/** One run: its conversation, the reply box, and the files it produced. */
export function RunView({ run, events, heldReply = false }: Props) {
  const items = useMemo(() => buildTranscript(events, run.agent), [events, run.agent])
  const agent = AGENT_LABEL[run.agent]
  // Codex runs one process per turn: between turns a waiting run has no process, and "End" just closes it.
  const perTurn = run.agent === 'codex'
  const canEnd = run.live || (perTurn && run.status === 'waiting')
  const { navigate } = useNavigation()
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)
  const applier = useApply(setError)

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

  return (
    <Stack gap="md">
      <Card withBorder radius="md" padding="md">
        <Stack gap="xs">
          <Group justify="space-between" wrap="nowrap" align="flex-start">
            <Title order={3} lineClamp={2} style={{ minWidth: 0 }}>
              {run.title}
            </Title>
            <Group gap="xs" wrap="nowrap" style={{ flexShrink: 0 }}>
              <Badge size="lg" color={AGENT_COLOR[run.agent]} variant="outline">
                {agent}
              </Badge>
              <Badge
                size="lg"
                color={STATUS_LABEL[run.status].color}
                variant="light"
                leftSection={working ? <Loader size={10} color="blue" /> : undefined}
              >
                {runStatusLabel(run.status, run.agent)}
              </Badge>
            </Group>
          </Group>
          <Text size="xs" c="dimmed">
            {runCost(run)} · started{' '}
            {new Date(run.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </Text>
          {(run.outputFolder || canEnd) && (
            <Group gap="xs">
              {run.outputFolder && has('resume.pdf') && (
                <Button
                  size="xs"
                  leftSection={<IconSend size={16} />}
                  loading={applier.busy}
                  onClick={() => run.outputFolder && applier.apply({ id: run.outputFolder })}
                  title="Fill the posting's application form in the in-app browser; you submit it yourself"
                >
                  Apply
                </Button>
              )}
              {run.outputFolder && has('resume.pdf') && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconFileTypePdf size={16} />}
                  onClick={() => act(() => api.runner.openOutput(run.id, 'resume.pdf'))}
                >
                  Resume
                </Button>
              )}
              {run.outputFolder && has('cover.pdf') && (
                <Button
                  size="xs"
                  variant="light"
                  leftSection={<IconFileTypePdf size={16} />}
                  onClick={() => act(() => api.runner.openOutput(run.id, 'cover.pdf'))}
                >
                  Cover letter
                </Button>
              )}
              {run.outputFolder && (
                <Button
                  size="xs"
                  variant="default"
                  leftSection={<IconFolder size={16} />}
                  onClick={() => act(() => api.runner.revealOutput(run.id))}
                >
                  Show in Finder
                </Button>
              )}
              {canEnd && (
                <Menu position="bottom-end">
                  <Menu.Target>
                    <Button size="xs" variant="default" leftSection={<IconPlayerStop size={16} />} ml="auto">
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
            </Group>
          )}
          {run.outputFolder && (
            <Text size="xs" c="dimmed" ff="monospace">
              {run.outputFolder}/ · {run.outputFiles.join(', ')}
            </Text>
          )}
        </Stack>
      </Card>

      {run.error && run.status === 'failed' && (
        <Alert color="red" variant="light" title={`${agent} stopped with an error`}>
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

      <Transcript items={items} />

      {working && (
        <Group gap="xs" c="dimmed">
          <Loader size="xs" type="dots" />
          <Text size="sm">{agent} is working…</Text>
        </Group>
      )}

      {heldReply && (
        <Alert color="yellow" variant="light">
          Your reply is held: the tailoring queue already has as many runs working as it allows. It is sent as soon
          as one of them finishes its turn (change "at a time" in the queue to allow more).
        </Alert>
      )}
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Opaque dock so the transcript does not show through below the reply box. */}
      <Box pb="md" style={{ position: 'sticky', bottom: 0, zIndex: 5, background: 'var(--mantine-color-body)' }}>
        <Card withBorder radius="md" padding="sm">
          <Group align="flex-end" wrap="nowrap">
            <Textarea
              style={{ flex: 1 }}
              autosize
              minRows={1}
              maxRows={8}
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
            <Button
              leftSection={<IconSend size={16} />}
              onClick={send}
              loading={sending}
              disabled={!canReply || !reply.trim()}
            >
              Send
            </Button>
          </Group>
          <Text size="xs" c="dimmed" mt={4}>
            <Kbd size="xs">⌘</Kbd> + <Kbd size="xs">Enter</Kbd> to send
          </Text>
        </Card>
      </Box>
      <div ref={bottom} />
      {applier.modal}
    </Stack>
  )
}
