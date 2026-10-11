import { useState } from 'react'
import { Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core'
import { IconBookmark, IconClipboardCheck, IconLink } from '@tabler/icons-react'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import classes from './jobs.module.css'

/** Pasted text shorter than this is not a posting. */
const MIN_CHARS = 50

/** Save a job from pasted text, for boards that block reading or postings shared as text (Figma Jobs — Paste a job). */
export function PasteModal({
  opened,
  onClose,
  onSaved
}: {
  opened: boolean
  onClose(): void
  onSaved(job: Job): void
}) {
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const chars = text.trim().length

  async function save() {
    setBusy(true)
    setError(null)
    try {
      onSaved(await api.jobs.addPasted({ title, company, url, text }))
      setTitle('')
      setCompany('')
      setUrl('')
      setText('')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal.Root opened={opened} onClose={onClose} size={600} centered>
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header className={classes.modalHeader}>
          <span className={classes.modalIcon} aria-hidden>
            <IconClipboardCheck size={20} />
          </span>
          <Modal.Title className={classes.modalTitle}>Paste a job</Modal.Title>
          <Modal.CloseButton aria-label="Close" />
        </Modal.Header>
        <Modal.Body className={classes.modalBody}>
          <Stack gap={14}>
            <p className={classes.intro}>
              For boards Huntgry cannot read by URL (Indeed, LinkedIn). Title and company are picked from the first
              lines if you leave them empty.
            </p>
            <Group grow gap={12} align="flex-start">
              <TextInput
                label="Title"
                placeholder="from the first line if empty"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
              />
              <TextInput label="Company" placeholder="Company" value={company} onChange={(e) => setCompany(e.currentTarget.value)} />
            </Group>
            <TextInput
              label="Posting URL"
              leftSection={<IconLink size={16} />}
              placeholder="https://… (optional)"
              value={url}
              onChange={(e) => setUrl(e.currentTarget.value)}
            />
            <Textarea
              label="Job description"
              autosize
              minRows={8}
              maxRows={16}
              value={text}
              error={error}
              description={`At least ${MIN_CHARS} characters · ${chars.toLocaleString()} so far`}
              inputWrapperOrder={['label', 'input', 'description', 'error']}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <div className={classes.footer}>
              <Button variant="subtle" onClick={onClose}>
                Cancel
              </Button>
              <Button leftSection={<IconBookmark size={16} />} onClick={save} loading={busy} disabled={chars < MIN_CHARS}>
                Save job
              </Button>
            </div>
          </Stack>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  )
}
