import { useState } from 'react'
import { Alert, Code, Collapse, Text, Typography, UnstyledButton } from '@mantine/core'
import { IconAlertTriangle, IconChevronDown, IconCircleCheck, IconCircleX, IconLoader2, IconSparkles } from '@tabler/icons-react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { AGENT_LABEL, type AgentId, type TranscriptItem, type TurnMetrics } from '@shared/runner-types'
import { formatUsage } from '@shared/transcript'
import { turnFooter } from '../../components/usage/format'
import classes from './tailor.module.css'

type Item = TranscriptItem
type Block = { kind: 'turn'; id: string; items: Item[] } | { kind: 'user' | 'notice'; id: string; item: Item }

/**
 * Folds the flat transcript into what the page draws: the user's messages on their own, and each
 * stretch of the agent's replies, tool calls and the turn's result as one block (a block ends at
 * its result, a user message or a notice).
 */
export function groupTranscript(items: readonly Item[]): Block[] {
  const blocks: Block[] = []
  let turn: Extract<Block, { kind: 'turn' }> | null = null
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'notice') {
      turn = null
      blocks.push({ kind: item.kind, id: item.id, item })
      continue
    }
    if (!turn) {
      turn = { kind: 'turn', id: item.id, items: [] }
      blocks.push(turn)
    }
    turn.items.push(item)
    if (item.kind === 'result') turn = null
  }
  return blocks
}

interface Props {
  items: TranscriptItem[]
  metrics?: TurnMetrics[]
  /** Names the agent on each of its blocks. */
  agent?: AgentId
}

/** The conversation: the user's messages, the agent's replies (Markdown), compact tool calls and turn results. */
export function Transcript({ items, metrics = [], agent }: Props) {
  return (
    <div className={classes.transcript}>
      {groupTranscript(items).map((block) => {
        if (block.kind === 'user' && block.item.kind === 'user') {
          return (
            <div key={block.id} className={classes.userRow}>
              <div className={classes.userBubble}>
                <Text size="sm" lineClamp={12} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {block.item.text}
                </Text>
              </div>
            </div>
          )
        }
        if (block.kind === 'notice' && block.item.kind === 'notice') {
          return (
            <Alert key={block.id} color={block.item.level === 'error' ? 'danger' : 'gray'}>
              <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
                {block.item.text}
              </Text>
            </Alert>
          )
        }
        if (block.kind !== 'turn') return null
        return (
          <div key={block.id} className={classes.turn}>
            <span className={classes.turnAgent}>
              <IconSparkles size={14} aria-hidden />
              {agent ? AGENT_LABEL[agent] : 'Agent'}
            </span>
            {block.items.map((item) => (
              <TurnItem key={item.id} item={item} metrics={metrics} />
            ))}
          </div>
        )
      })}
    </div>
  )
}

function TurnItem({ item, metrics }: { item: Item; metrics: TurnMetrics[] }) {
  switch (item.kind) {
    case 'assistant':
      return <Markdown text={item.text} />
    case 'tool':
      return <ToolRow item={item} />
    case 'result': {
      // The same time · tokens · est. cost for every agent (#44); the raw CLI figures for an unmeasured turn.
      const turn = item.turn ? metrics.find((m) => m.turn === item.turn) : undefined
      return (
        <>
          <span className={classes.monoXs} style={{ whiteSpace: 'normal' }}>
            {[
              item.ok ? 'Turn finished' : `Turn ended with an error: ${item.text}`,
              ...(turn
                ? [turnFooter(turn)]
                : [
                    item.usage ? formatUsage(item.usage) : `$${item.costUsd.toFixed(2)}`,
                    ...(item.durationMs > 0 ? [`${Math.round(item.durationMs / 1000)}s`] : [])
                  ])
            ].join(' · ')}
          </span>
          {item.denials.length > 0 && (
            <Alert color="warning" icon={<IconAlertTriangle size={18} />} title="Blocked tool calls">
              <Text size="sm" c="var(--hg-text-secondary)">
                Huntgry only lets the agent run what the skill needs. These were refused:
              </Text>
              {item.denials.map((d, i) => (
                <Code key={i} block mt={4}>
                  {d}
                </Code>
              ))}
            </Alert>
          )}
        </>
      )
    }
    default:
      return null
  }
}

export function Markdown({ text }: { text: string }) {
  return (
    <Typography className={classes.markdown} style={{ fontSize: 'var(--mantine-font-size-sm)' }}>
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
      <IconLoader2 size={12} className="huntgry-spin" />
    ) : item.status === 'ok' ? (
      <IconCircleCheck size={12} />
    ) : (
      <IconCircleX size={12} />
    )
  return (
    <div className={classes.tool}>
      <UnstyledButton className={classes.toolRow} onClick={() => setOpen((o) => !o)} disabled={!item.output} aria-expanded={item.output ? open : undefined}>
        <span className={classes.toolIcon} data-status={item.status}>
          {icon}
        </span>
        <span className={classes.chip}>{item.name}</span>
        <span className={classes.toolSummary}>{item.summary}</span>
        {item.output && <IconChevronDown size={12} className={classes.chevron} data-open={open || undefined} />}
      </UnstyledButton>
      <Collapse expanded={open}>
        <Code block className={classes.toolOutput}>
          {item.output}
        </Code>
      </Collapse>
    </div>
  )
}
