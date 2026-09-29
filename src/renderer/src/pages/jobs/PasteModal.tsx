import { useState } from 'react'
import { Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'

/** Save a job from pasted text (for boards that block reading, or postings shared as text). */
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
    <Modal opened={opened} onClose={onClose} title="Paste a job" size="lg" centered>
      <Stack gap="sm">
        <Group grow>
          <TextInput
            label="Title"
            placeholder="from the first line if empty"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
          <TextInput label="Company" value={company} onChange={(e) => setCompany(e.currentTarget.value)} />
        </Group>
        <TextInput
          label="Posting URL"
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
          onChange={(e) => setText(e.currentTarget.value)}
        />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={text.trim().length < 50}>
            Save job
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}
