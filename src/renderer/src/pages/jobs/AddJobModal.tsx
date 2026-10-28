import { useState } from 'react'
import { Alert, Button, Group, Modal, Stack, TextInput, Textarea } from '@mantine/core'
import { IconBookmark, IconLink, IconPlus } from '@tabler/icons-react'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { addJobInput, MIN_CHARS } from './addJob'
import classes from './jobs.module.css'

/**
 * "Add job" (#189): the one way to add a job, on both Jobs tabs, the Board and the ⌘K palette. One box takes a
 * posting's link (Huntgry reads the posting) or its text, for boards that block reading or postings shared as
 * text; with text, title, company and link are optional (Figma Jobs — Paste a job).
 */
export function AddJobModal({
  opened,
  onClose,
  onSaved
}: {
  opened: boolean
  onClose(): void
  onSaved(job: Job): void
}) {
  const [value, setValue] = useState('')
  const [title, setTitle] = useState('')
  const [company, setCompany] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const input = addJobInput(value)
  const chars = value.trim().length

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const job = input === 'link' ? await api.jobs.addByUrl(value.trim()) : await api.jobs.addPasted({ title, company, url, text: value })
      onSaved(job)
      setValue('')
      setTitle('')
      setCompany('')
      setUrl('')
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
            <IconPlus size={20} />
          </span>
          <Modal.Title className={classes.modalTitle}>Add job</Modal.Title>
          <Modal.CloseButton aria-label="Close" />
        </Modal.Header>
        <Modal.Body className={classes.modalBody}>
          <Stack gap={14}>
            <p className={classes.intro}>
              Paste the posting's link (a careers page, Greenhouse, Lever, Ashby, Workday …) and Huntgry reads it. For
              boards it cannot read (Indeed, LinkedIn), paste the posting's text instead.
            </p>
            <Textarea
              label="Link or posting text"
              placeholder="https://… or the full job description"
              autosize
              minRows={4}
              maxRows={16}
              data-autofocus
              value={value}
              description={
                input === 'link'
                  ? 'A link: Huntgry reads the posting from it.'
                  : input === 'empty'
                    ? `A link, or at least ${MIN_CHARS} characters of the posting`
                    : `Posting text: at least ${MIN_CHARS} characters · ${chars.toLocaleString()} so far`
              }
              inputWrapperOrder={['label', 'input', 'description']}
              onChange={(e) => setValue(e.currentTarget.value)}
            />
            {/* Why the link could not be read (a bot wall, a private address): paste the text instead. */}
            {error && (
              <Alert color="danger" variant="light" withCloseButton onClose={() => setError(null)}>
                {error}
              </Alert>
            )}
            {/* Only text needs them: a link gives the title and company itself. */}
            {(input === 'text' || input === 'short') && (
              <>
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
              </>
            )}
            <div className={classes.footer}>
              <Button variant="subtle" onClick={onClose}>
                Cancel
              </Button>
              <Button
                leftSection={<IconBookmark size={16} />}
                onClick={() => void save()}
                loading={busy}
                disabled={input !== 'link' && input !== 'text'}
              >
                Save job
              </Button>
            </div>
          </Stack>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  )
}
