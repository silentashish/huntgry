import { Button, ScrollArea } from '@mantine/core'
import { IconPlus, IconSend } from '@tabler/icons-react'
import type { RunSummary } from '@shared/runner-types'
import { StatusPill } from '../../components/ui'
import { runBadge } from '../../components/usage/format'
import { AgentPill, MonoXs } from './parts'
import { runStatusLabel, shortWhen, STATUS_LABEL } from './status'
import classes from './tailor.module.css'

interface Props {
  runs: RunSummary[]
  selected: string | null
  onSelect(id: string | null): void
}

/** Past and active runs of this workspace, newest first. */
export function RunList({ runs, selected, onSelect }: Props) {
  const waiting = runs.filter((r) => r.status === 'waiting').length
  const now = new Date()
  return (
    <div className={classes.list}>
      <Button
        fullWidth
        leftSection={<IconPlus size={16} />}
        variant={selected === null ? 'secondary' : 'default'}
        onClick={() => onSelect(null)}
      >
        New run
      </Button>
      {waiting > 0 && (
        <div className={classes.waitingNote}>
          <IconSend size={18} aria-hidden style={{ flex: '0 0 auto' }} />
          <span>
            {waiting} run{waiting === 1 ? '' : 's'} waiting for your reply
          </span>
        </div>
      )}
      <ScrollArea.Autosize mah="calc(100vh - 180px)" offsetScrollbars="y">
        <div className={classes.list}>
          {runs.length === 0 && <p className={classes.emptyList}>No runs yet in this workspace.</p>}
          {runs.map((r) => {
            const badge = runBadge(r)
            const status = STATUS_LABEL[r.status]
            return (
              // A real button: focusable, named by its title (then its status line).
              <button
                key={r.id}
                type="button"
                className={classes.runItem}
                aria-current={r.id === selected ? 'true' : undefined}
                onClick={() => onSelect(r.id)}
              >
                <span className={classes.runItemHead}>
                  <span className={classes.runItemTitle} title={r.title}>
                    {r.title}
                  </span>
                  <StatusPill tone={status.tone} dot>
                    {runStatusLabel(r.status, r.agent)}
                  </StatusPill>
                </span>
                <span className={classes.runItemRow}>
                  <AgentPill agent={r.agent} />
                  <MonoXs title={new Date(r.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}>
                    {shortWhen(r.createdAt, now)}
                  </MonoXs>
                </span>
                {badge && <MonoXs testId="run-usage">{badge}</MonoXs>}
              </button>
            )
          })}
        </div>
      </ScrollArea.Autosize>
    </div>
  )
}
