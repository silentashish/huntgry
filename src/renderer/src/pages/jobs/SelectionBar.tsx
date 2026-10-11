import { ActionIcon, Button } from '@mantine/core'
import { IconCpu, IconSparkles, IconTrash, IconX } from '@tabler/icons-react'
import classes from './jobs.module.css'

interface Props {
  count: number
  dismissing: boolean
  onTailor(): void
  onUnattended(): void
  onDismiss(): void
  onClear(): void
}

/** The floating bar of bulk actions once jobs are ticked (Figma Jobs — Relevant, SelectionBar). */
export function SelectionBar({ count, dismissing, onTailor, onUnattended, onDismiss, onClear }: Props) {
  if (count === 0) return null
  return (
    <div className={classes.selectionDock}>
      <div className={classes.selectionBar} role="group" aria-label="Selected jobs">
        <span className={classes.selectionCount}>{count} selected</span>
        <span className={classes.divider} aria-hidden />
        <Button size="xs" leftSection={<IconSparkles size={14} />} onClick={onTailor}>
          Tailor all
        </Button>
        <Button size="xs" variant="light" color="trail" leftSection={<IconCpu size={14} />} onClick={onUnattended}>
          Run unattended
        </Button>
        <Button size="xs" variant="subtle" leftSection={<IconTrash size={14} />} loading={dismissing} onClick={onDismiss}>
          Dismiss
        </Button>
        <ActionIcon variant="subtle" size="sm" aria-label="Clear selection" onClick={onClear}>
          <IconX size={14} />
        </ActionIcon>
      </div>
    </div>
  )
}
