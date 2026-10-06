import { useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Code,
  Collapse,
  Group,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Typography,
  UnstyledButton
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconChevronRight, IconLoader2, IconTool, IconX } from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { TranscriptItem, TurnMetrics } from '@shared/runner-types'
import { formatUsage } from '@shared/transcript'
import { turnFooter } from '../../components/usage/format'

/** The conversation: the user's messages, the agent's replies (Markdown), compact tool calls and turn results. */
export function Transcript({ items, metrics = [] }: { items: TranscriptItem[]; metrics?: TurnMetrics[] }) {
  return (
    <Stack gap="sm">
      {items.map((item) => {
        switch (item.kind) {
          case 'user':
            return (
              <Group key={item.id} justify="flex-end">
                <Paper radius="lg" p="sm" px="md" maw="85%" bg="var(--mantine-color-blue-light)">
                  <Text size="sm" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} lineClamp={12}>
                    {item.text}
                  </Text>
                </Paper>
              </Group>
            )
          case 'assistant':
            return (
              <Paper key={item.id} radius="lg" p="sm" px="md" withBorder>
                <Markdown text={item.text} />
              </Paper>
            )
          case 'tool':
            return <ToolRow key={item.id} item={item} />
          case 'result': {
            // The same time · tokens · est. cost for every agent (#44); the raw CLI figures for an unmeasured turn.
            const turn = item.turn ? metrics.find((m) => m.turn === item.turn) : undefined
            return (
              <Stack key={item.id} gap={4}>
                <Text size="xs" c="dimmed" ta="center">
                  {[
                    item.ok ? 'Turn finished' : `Turn ended with an error: ${item.text}`,
                    ...(turn
                      ? [turnFooter(turn)]
                      : [
                          item.usage ? formatUsage(item.usage) : `$${item.costUsd.toFixed(2)}`,
                          ...(item.durationMs > 0 ? [`${Math.round(item.durationMs / 1000)}s`] : [])
                        ])
                  ].join(' · ')}
                </Text>
                {item.denials.length > 0 && (
                  <Alert
                    color="orange"
                    variant="light"
                    icon={<IconAlertTriangle size={16} />}
                    title="Blocked tool calls"
                  >
                    <Text size="xs">Huntgry only lets the agent run what the skill needs. These were refused:</Text>
                    {item.denials.map((d, i) => (
                      <Code key={i} block mt={4}>
                        {d}
                      </Code>
                    ))}
                  </Alert>
                )}
              </Stack>
            )
          }
          case 'notice':
            return (
              <Alert key={item.id} color={item.level === 'error' ? 'red' : 'gray'} variant="light">
                <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                  {item.text}
                </Text>
              </Alert>
            )
        }
      })}
    </Stack>
  )
}

export function Markdown({ text }: { text: string }) {
  return (
    <Typography style={{ fontSize: 'var(--mantine-font-size-sm)' }}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Links open in the OS browser (main's window-open handler); the app never navigates.
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          )
        }}
      >
        {text}
      </ReactMarkdown>
    </Typography>
  )
}

function ToolRow({ item }: { item: Extract<TranscriptItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false)
  const icon =
    item.status === 'running' ? (
      <IconLoader2 size={14} className="huntgry-spin" />
    ) : item.status === 'ok' ? (
      <IconCheck size={14} />
    ) : (
      <IconX size={14} />
    )
  const color = item.status === 'running' ? 'blue' : item.status === 'ok' ? 'gray' : 'red'
  return (
    <Box>
      <UnstyledButton onClick={() => setOpen((o) => !o)} disabled={!item.output} w="100%">
        <Group gap="xs" wrap="nowrap">
          <ThemeIcon size="sm" variant="light" color={color} radius="xl">
            {icon}
          </ThemeIcon>
          <Badge
            size="sm"
            variant="outline"
            color="gray"
            leftSection={<IconTool size={10} />}
            style={{ flexShrink: 0 }}
          >
            {item.name}
          </Badge>
          <Text size="xs" c="dimmed" truncate style={{ minWidth: 0, flex: 1 }}>
            {item.summary}
          </Text>
          {item.output && (
            <IconChevronRight
              size={14}
              style={{ transform: open ? 'rotate(90deg)' : undefined, transition: 'transform 120ms', flexShrink: 0 }}
            />
          )}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Code block mt={4} style={{ maxHeight: 260, overflow: 'auto', fontSize: 11 }}>
          {item.output}
        </Code>
      </Collapse>
    </Box>
  )
}
