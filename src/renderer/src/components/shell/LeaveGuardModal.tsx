import { Button, Modal } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { toneStyle } from '../ui'
import classes from './shell.module.css'

/**
 * The navigation guard's question (Figma "Profile — Leave guard modal" 17:1030): warning icon tile,
 * "Discard unsaved changes?", the page's message, Keep editing / Discard and leave. Same look as the
 * Profile page's ConfirmModal (#115); to be deduplicated once both branches merge.
 */
export function LeaveGuardModal({ message, onKeep, onDiscard }: { message: string | null; onKeep(): void; onDiscard(): void }) {
  return (
    <Modal
      opened={message !== null}
      onClose={onKeep}
      centered
      size={460}
      radius="var(--hg-radius-2xl)"
      padding="lg"
      withCloseButton={false}
      classNames={{ title: classes.guardTitle, header: classes.guardHeader, body: classes.guardBody }}
      title={
        <span className={classes.guardTitleRow}>
          <span className={classes.guardIcon} style={toneStyle('warning')} aria-hidden>
            <IconAlertTriangle size={18} />
          </span>
          <span>Discard unsaved changes?</span>
        </span>
      }
    >
      <div className={classes.guardText}>{message}</div>
      <div className={classes.guardActions}>
        <Button variant="default" onClick={onKeep}>
          Keep editing
        </Button>
        <Button color="danger" onClick={onDiscard}>
          Discard and leave
        </Button>
      </div>
    </Modal>
  )
}
