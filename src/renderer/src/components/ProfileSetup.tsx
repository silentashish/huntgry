import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button } from '@mantine/core'
import { IconFileText, IconPencil, IconUpload } from '@tabler/icons-react'
import { resumeExtensionOf, type MasterProfile, type ResumeImportResult } from '@shared/master-profile'
import { api, errorText } from '../api'
import { Notice } from './first-run/Notice'
import classes from './first-run/first-run.module.css'
import { MonoLabel } from './ui'

interface Props {
  workspacePath: string
  onImported(draft: { profile: MasterProfile; fileName: string; warnings: string[] }): void
  onManual(): void
}

/** True while the drag carries files (not text or a link). */
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

/** Step after Create (Figma 15:92): seed the empty master profile from a resume (picked or dropped), or fill it by hand. */
export function ProfileSetup({ workspacePath, onImported, onManual }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const busyRef = useRef(false)

  async function importWith(read: () => Promise<ResumeImportResult>) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const result = await read()
      if (result.ok) onImported(result)
      else if (!result.cancelled) setError(result.error ?? 'Could not read the resume.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  // "…or drop a resume anywhere on this window": the whole window is the drop target.
  const importDropped = useRef<(files: FileList) => void>(() => {})
  importDropped.current = (files: FileList) => {
    if (files.length === 0) return
    if (files.length > 1) {
      setError('Drop one resume at a time.')
      return
    }
    const file = files[0]
    if (!resumeExtensionOf(file.name)) {
      setError(`${file.name}: Unsupported file type. Use .docx, .pdf, .txt or .md.`)
      return
    }
    void importWith(() => api.profile.importResumeFile(file))
  }

  useEffect(() => {
    let depth = 0 // dragenter/dragleave fire for every child element crossed
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const over = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault() // allow the drop
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      if (e.dataTransfer) importDropped.current(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  return (
    <section aria-label="Set up your master profile" className={classes.body} data-width="setup">
      <Notice tone="success">
        <span>
          The workspace is ready, with an empty <span translate="no">master-profile.md</span> in
        </span>
        <MonoLabel tone="primary">{workspacePath}</MonoLabel>
      </Notice>

      {error && (
        <Notice tone="danger" role="status">
          <span>{error}</span>
        </Notice>
      )}

      <div className={classes.choices}>
        <SetupOption
          accent
          icon={<IconUpload size={20} />}
          title="Import from a resume"
          text="Pick your current resume (.docx, .pdf, .txt or .md). Huntgry reads it on this computer, fills in the form, and lets you review everything before saving."
          action={
            <Button leftSection={<IconUpload size={16} />} loading={busy} onClick={() => importWith(() => api.profile.importResume())}>
              Choose resume file…
            </Button>
          }
        />
        <SetupOption
          icon={<IconPencil size={20} />}
          title="Fill it in manually"
          text="Start from an empty form: contact details, summary, skills, experience, projects, education, certifications and publications. You can import a resume later too."
          action={
            <Button variant="default" leftSection={<IconPencil size={16} />} disabled={busy} onClick={onManual}>
              Start with an empty form
            </Button>
          }
        />
      </div>

      <div className={classes.dropZone} data-active={dragging || undefined}>
        <IconFileText size={28} stroke={1.5} />
        <p className={classes.dropText}>{dragging ? 'Drop the resume to import it' : '…or drop a resume anywhere on this window'}</p>
        <MonoLabel size="xs">.docx · .pdf · .txt · .md · parsed locally</MonoLabel>
      </div>

      <p className={classes.footnote}>
        The profile is a plain Markdown file. You can also edit it in any text editor; Huntgry reads it again every time it
        opens.
      </p>
    </section>
  )
}

function SetupOption({ icon, title, text, action, accent }: { icon: ReactNode; title: string; text: string; action: ReactNode; accent?: boolean }) {
  return (
    <div className={classes.option} data-accent={accent || undefined}>
      <span className={classes.optionIcon} aria-hidden>
        {icon}
      </span>
      <h3 className={classes.optionTitle}>{title}</h3>
      <p className={classes.optionText}>{text}</p>
      {action}
    </div>
  )
}
