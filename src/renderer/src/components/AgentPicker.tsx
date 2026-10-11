import { useId } from 'react'
import { Tooltip } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { AGENT_IDS, AGENT_LABEL, type AgentId, type AgentStatus, type RunnerEnvironment } from '@shared/runner-types'
import classes from './AgentPicker.module.css'

interface Props {
  environment: RunnerEnvironment | null
  value: AgentId
  onChange(agent: AgentId): void
  label?: string
  /** `xs` compact cards (one line), `sm` a little taller. Ignored with `detailed`. */
  size?: 'xs' | 'sm'
  /** Cards with a second line: the CLI's version and whether it can run (the Tailor form). */
  detailed?: boolean
}

/**
 * Claude / Codex / Antigravity as radio cards (Figma: Tailor — New run, Jobs — Tailor all). An agent
 * whose CLI or skill is missing is dimmed and marked, with the reason on hover. It can still be
 * picked, so the form can say what to fix and offer the fix (e.g. "Install skill") in place;
 * starting a run with it stays blocked until then. Each choice is a native radio named
 * "Claude (default)", "Codex", or "<name>: not available".
 */
export function AgentPicker({ environment, value, onChange, label = 'Agent', size = 'xs', detailed = false }: Props) {
  const group = useId()
  return (
    <div className={classes.root} data-detailed={detailed || undefined}>
      <span className={classes.label} id={`${group}-label`}>
        {label}
      </span>
      <div className={classes.cards} role="radiogroup" aria-labelledby={`${group}-label`}>
        {AGENT_IDS.map((id) => {
          const s = environment?.agents.find((a) => a.id === id)
          const isDefault = id === environment?.defaultAgent
          const name = `${AGENT_LABEL[id]}${isDefault ? ' (default)' : ''}`
          const unavailable = !!s && !s.ready
          const card = (
            <label
              key={id}
              className={classes.card}
              data-size={detailed ? 'detailed' : size}
              data-checked={value === id || undefined}
              data-unavailable={unavailable || undefined}
            >
              <input
                type="radio"
                className={classes.input}
                name={group}
                value={id}
                checked={value === id}
                onChange={() => onChange(id)}
                aria-label={unavailable ? `${name}: not available` : name}
              />
              <span className={classes.radio} aria-hidden />
              <span className={classes.text} aria-hidden>
                <span className={classes.nameRow}>
                  <span className={classes.name}>{AGENT_LABEL[id]}</span>
                  {isDefault && <span className={classes.defaultTag}>default</span>}
                  {unavailable && !detailed && <IconAlertTriangle size={12} className={classes.warn} />}
                </span>
                {detailed && <span className={classes.sub}>{agentLine(environment, s)}</span>}
              </span>
            </label>
          )
          return unavailable ? (
            <Tooltip key={id} label={s.problems[0]} multiline w={300} withArrow>
              {card}
            </Tooltip>
          ) : (
            card
          )
        })}
      </div>
    </div>
  )
}

/** The second line of a card: `v2.1.4 · signed in`, `v0.48 · skill linked`, `not installed`. */
export function agentLine(environment: RunnerEnvironment | null, s: AgentStatus | undefined): string {
  if (!environment || !s) return 'checking…'
  const version = s.version ? `v${s.version}` : null
  if (!s.cliPath) return 'not installed'
  if (s.id === 'claude' && environment.claudeAuth && !environment.claudeAuth.loggedIn) return [version, 'not signed in'].filter(Boolean).join(' · ')
  if (!s.skillPath) return [version, 'skill missing'].filter(Boolean).join(' · ')
  if (!s.ready) return [version, 'not ready'].filter(Boolean).join(' · ')
  const state = s.id === 'claude' && environment.claudeAuth?.loggedIn ? 'signed in' : 'skill linked'
  return [version, state].filter(Boolean).join(' · ')
}

/** The status of `agent` in the environment report, when known. */
export function agentStatus(environment: RunnerEnvironment | null, agent: AgentId) {
  return environment?.agents.find((a) => a.id === agent) ?? null
}
