import type { ReactNode } from 'react'
import { IconCpu } from '@tabler/icons-react'
import { AGENT_LABEL, type AgentId } from '@shared/runner-types'
import { StatusPill } from '../../components/ui'
import { AGENT_TONE } from './status'
import classes from './tailor.module.css'

/** The agent of a run or queue item: an outline pill in the agent's tone with the CPU icon (Figma Badge/ember, trail, review). */
export function AgentPill({ agent }: { agent: AgentId }) {
  return (
    <StatusPill tone={AGENT_TONE[agent]} variant="outline" size="md" leftSection={<IconCpu size={12} />}>
      {AGENT_LABEL[agent]}
    </StatusPill>
  )
}

/** A 10 px mono readout (times, tokens, costs, dates). */
export function MonoXs({ children, testId, title }: { children: ReactNode; testId?: string; title?: string }) {
  return (
    <span className={classes.monoXs} data-testid={testId} title={title}>
      {children}
    </span>
  )
}

/** A small mono chip in a queue row (`attempt 2`, `retry 1/2`, `usage limit`). */
export function Chip({ children, tone }: { children: ReactNode; tone?: 'warning' }) {
  return (
    <span className={classes.chip} data-tone={tone}>
      {children}
    </span>
  )
}
