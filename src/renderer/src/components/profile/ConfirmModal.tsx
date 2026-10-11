import type { ReactNode } from 'react'
import { Button, Modal } from '@mantine/core'
import { IconAlertTriangle } from '@tabler/icons-react'
import { toneStyle, type UiTone } from '../ui'
import classes from './editor.module.css'

export interface ConfirmModalProps {
  opened: boolean
  title: string
  children: ReactNode
  /** Tone of the icon tile; default `warning`. */
  tone?: UiTone
  /** 18 px icon in the tile; default the warning triangle. */
  icon?: ReactNode
  cancelLabel?: string
  confirmLabel: string
  /** `danger` for throwing work away (solid red), `primary` otherwise. */
  confirmKind?: 'danger' | 'primary'
  onCancel(): void
  onConfirm(): void
}

/**
 * A yes/no question in the Figma "Profile — Leave guard modal" look: icon tile, title, one
 * paragraph, Keep / Discard buttons on the right. The dialog is named by its title.
 */
export function ConfirmModal({
  opened,
  title,
  children,
  tone = 'warning',
  icon,
  cancelLabel = 'Cancel',
  confirmLabel,
  confirmKind = 'danger',
  onCancel,
  onConfirm
}: ConfirmModalProps) {
  return (
    <Modal
      opened={opened}
      onClose={onCancel}
      centered
      size={460}
      radius="var(--hg-radius-2xl)"
      padding="lg"
      withCloseButton={false}
      classNames={{ title: classes.modalTitle, header: classes.modalHeader, body: classes.modalBody }}
      title={
        <span className={classes.modalTitleRow}>
          <span className={classes.modalIcon} style={toneStyle(tone)} aria-hidden>
            {icon ?? <IconAlertTriangle size={18} />}
          </span>
          <span>{title}</span>
        </span>
      }
    >
      <div className={classes.modalText}>{children}</div>
      <div className={classes.modalActions}>
        <Button variant="default" onClick={onCancel}>
          {cancelLabel}
        </Button>
        {confirmKind === 'danger' ? (
          <Button color="danger" onClick={onConfirm}>
            {confirmLabel}
          </Button>
        ) : (
          <Button onClick={onConfirm}>{confirmLabel}</Button>
        )}
      </div>
    </Modal>
  )
}
