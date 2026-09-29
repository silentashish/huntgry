import { useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Badge, Box, Button, Card, Group, Kbd, Loader, Menu, Stack, Text, Textarea, Title } from '@mantine/core'
import { IconFileTypePdf, IconFolder, IconPlayerStop, IconSend } from '@tabler/icons-react'
import type { RunSummary } from '@shared/runner-types'
import { buildTranscript } from '@shared/transcript'
import { api, errorText } from '../../api'
import { STATUS_LABEL } from './status'
import { Transcript } from './Transcript'

interface Props {
  run: RunSummary
  events: unknown[]
}

/** One run: its conversation, the reply box, and the files it produced. */
export function RunView({ run, events }: Props) {
  const items = useMemo(() => buildTranscript(events), [events])
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  // Block body: Chromium's scrollIntoView returns a Promise, which React would take for a cleanup function.
  useEffect(() => {
    void bottom.current?.scrollIntoView({ block: 'end', behavior: 'smooth' })
  }, [items.length])

  const working = run.status === 'running'
  // A finished, stopped or failed run can be continued as long as Claude gave it a session.
  const canReply = !working && !sending && (run.live || run.sessionId !== null)

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
            <Badge
              size="lg"
              color={STATUS_LABEL[run.status].color}
              variant="light"
              style={{ flexShrink: 0 }}
              leftSection={working ? <Loader size={10} color="blue" /> : undefined}
            >
              {STATUS_LABEL[run.status].label}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            ${run.costUsd.toFixed(2)} · started{' '}
            {new Date(run.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
          </Text>
          {(run.outputFolder || run.live) && (
            <Group gap="xs">
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
              {run.live && (
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
                    <Menu.Item color="red" onClick={() => act(() => api.runner.stop(run.id))}>
                      Stop Claude now
                    </Menu.Item>
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
        <Alert color="red" variant="light" title="Claude stopped with an error">
          <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
            {run.error}
          </Text>
        </Alert>
      )}

      <Transcript items={items} />

      {working && (
        <Group gap="xs" c="dimmed">
          <Loader size="xs" type="dots" />
          <Text size="sm">Claude is working…</Text>
        </Group>
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
                  ? 'Reply to Claude, e.g. "Approved" or what to change…'
                  : run.live
                    ? 'Claude is working; you can reply when it asks.'
                    : run.sessionId
                      ? 'Continue this conversation (Claude resumes the session)…'
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
    </Stack>
  )
}
