import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Button, Group, Loader, Modal, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { IconCheck, IconFileText, IconFolder, IconFolderOpen, IconHistory, IconPlus } from '@tabler/icons-react'
import { canImport, createMode, type PickMode, type WorkspaceInspection } from '@shared/workspace-types'
import { api, errorText } from '../api'
import { Notice as NoticeBanner, type NoticeTone } from './first-run/Notice'
import classes from './first-run/first-run.module.css'
import { MonoLabel } from './ui'
import { WorkspaceStatus } from './WorkspaceStatus'

type Notice = { color: 'green' | 'red' | 'yellow'; text: string; offerCreate?: string } | null

const NOTICE_TONE: Record<NonNullable<Notice>['color'], NoticeTone> = { green: 'success', red: 'danger', yellow: 'warning' }

/** What Create writes into the folder (confirm modal, Figma 15:69). */
const WORKSPACE_FILES = [
  { name: 'master-profile.md', note: 'your master profile' },
  { name: 'cover-letter.md', note: 'optional base cover letter' },
  { name: 'CLAUDE.md', note: 'points the resume-tailor skill at this folder' }
] as const

interface Props {
  /** Called once a workspace with a master profile is open. `created` is true right after Create. */
  onOpened(inspection: WorkspaceInspection, created: boolean): void
  /** Shown on arrival, e.g. when the remembered workspace lost its master profile. */
  initialNotice?: Notice
}

/** Workspace picker (Figma 15:2): Create / Import cards, a typed path with its live status, notices and the confirm modal. */
export function WorkspacePicker({ onOpened, initialNotice = null }: Props) {
  const [typedPath, setTypedPath] = useState('')
  const [debouncedPath] = useDebouncedValue(typedPath, 300)
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null)
  const [notice, setNotice] = useState<Notice>(initialNotice)
  const [busy, setBusy] = useState<PickMode | null>(null)
  const [confirm, setConfirm] = useState<WorkspaceInspection | null>(null)
  // The remembered workspace when it can still be opened (after "Switch workspace").
  const [recent, setRecent] = useState<WorkspaceInspection | null>(null)
  // Bumped whenever the target changes (typing, picking). Async results from an
  // older generation are dropped, so the card and its buttons always match the
  // current input and never act on a previously inspected folder.
  const generation = useRef(0)

  useEffect(() => {
    let live = true
    api.workspace
      .getCurrent()
      .then((current) => live && setRecent(current && canImport(current) ? current : null))
      .catch(() => live && setRecent(null))
    return () => {
      live = false
    }
  }, [])

  // Live, read-only status for a typed path.
  useEffect(() => {
    if (!debouncedPath.trim()) return
    const gen = generation.current
    api.workspace
      .inspect(debouncedPath)
      .then((r) => gen === generation.current && setInspection(r))
      .catch((err: unknown) => {
        if (gen !== generation.current) return
        setInspection(null)
        setNotice({ color: 'red', text: errorText(err) })
      })
  }, [debouncedPath])

  function onTypedPathChange(value: string) {
    generation.current++
    setTypedPath(value)
    setInspection(null) // hide the old card and its action buttons immediately
    setNotice(null)
  }

  async function runCreate(path: string, gen: number, allowNonEmpty: boolean) {
    const result = await api.workspace.create(path, { allowNonEmpty })
    if (gen !== generation.current) return
    setInspection(result.inspection)
    if (result.ok) {
      onOpened(result.inspection, true)
    } else if (result.needsConfirmation) {
      setConfirm(result.inspection)
    } else {
      setNotice({ color: 'red', text: result.error ?? 'Could not create workspace.' })
    }
  }

  async function runImport(path: string, gen: number) {
    const result = await api.workspace.open(path)
    if (gen !== generation.current) return
    setInspection(result)
    if (canImport(result)) {
      onOpened(result, false)
    } else if (createMode(result)) {
      setNotice({
        color: 'red',
        text: `No master profile (master-profile.md) was found in ${result.path}. Create a new workspace to set one up.`,
        offerCreate: result.path
      })
    } else if (result.status === 'unverified') {
      setNotice({
        color: 'yellow',
        text: 'This folder is too large to verify, so it was not imported. Pick the workspace folder itself.'
      })
    } else {
      setNotice({ color: 'red', text: 'This folder cannot be imported as a Resume Tailor workspace.' })
    }
  }

  async function run(mode: PickMode, path?: string, allowNonEmpty = false) {
    setBusy(mode)
    try {
      const target = path ?? (await api.workspace.pickDirectory(mode))
      if (!target) return // picker cancelled: change nothing
      if (path === undefined) {
        // A picked folder replaces whatever was typed, so input and card never disagree.
        generation.current++
        setTypedPath('')
      }
      setNotice(null)
      const gen = generation.current
      await (mode === 'create' ? runCreate(target, gen, allowNonEmpty) : runImport(target, gen))
    } catch (err) {
      setNotice({ color: 'red', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const canCreateHere = inspection !== null && createMode(inspection) !== null
  const canImportHere = inspection !== null && canImport(inspection)
  const showActions = (canCreateHere || canImportHere) && !notice?.offerCreate

  return (
    <>
      <div className={classes.choices}>
        <ChoiceCard
          accent
          icon={<IconPlus size={24} />}
          title="Create new workspace"
          text="A fresh folder with master-profile.md, cover-letter.md and CLAUDE.md."
          loading={busy === 'create'}
          disabled={busy !== null}
          onClick={() => run('create')}
        />
        <ChoiceCard
          icon={<IconFolder size={24} />}
          title="Import existing workspace"
          text="A folder that already has a master profile (v3 or legacy)."
          loading={busy === 'import'}
          disabled={busy !== null}
          onClick={() => run('import')}
        />
      </div>

      <TextInput
        label="Or type a folder path"
        description="Absolute path or ~/…; a folder that does not exist yet can be created."
        placeholder="~/Workspace/cv"
        inputWrapperOrder={['label', 'input', 'description']}
        leftSection={<IconFolder size={16} />}
        classNames={{ input: classes.pathInput, label: classes.pathLabel, description: classes.pathDescription }}
        styles={{ label: { color: 'var(--hg-text-secondary)' } }}
        spellCheck={false}
        autoComplete="off"
        value={typedPath}
        onChange={(e) => onTypedPathChange(e.currentTarget.value)}
      />

      {notice && (
        <NoticeBanner
          tone={NOTICE_TONE[notice.color]}
          role="status"
          actions={
            notice.offerCreate && (
              <Button
                size="xs"
                leftSection={<IconPlus size={14} />}
                disabled={busy !== null}
                onClick={() => run('create', notice.offerCreate)}
              >
                Create workspace here
              </Button>
            )
          }
        >
          <span>{notice.text}</span>
        </NoticeBanner>
      )}

      {inspection && (
        <WorkspaceStatus
          inspection={inspection}
          actions={
            showActions && (
              <Group gap="xs">
                <Button
                  leftSection={<IconPlus size={16} />}
                  disabled={busy !== null || !canCreateHere}
                  onClick={() => run('create', inspection.path)}
                >
                  Create workspace here
                </Button>
                <Button
                  variant="default"
                  leftSection={<IconFolderOpen size={16} />}
                  disabled={busy !== null || !canImportHere}
                  onClick={() => run('import', inspection.path)}
                >
                  Import this workspace
                </Button>
              </Group>
            )
          }
        />
      )}

      {recent && recent.path !== inspection?.path && (
        <section className={classes.recent} aria-label="Last opened workspace">
          <span className={classes.recentIcon} aria-hidden>
            <IconHistory size={16} />
          </span>
          <div className={classes.recentText}>
            <MonoLabel size="xs">Last opened</MonoLabel>
            <MonoLabel tone="primary" className={classes.recentPath} title={recent.path}>
              {recent.path}
            </MonoLabel>
          </div>
          <Button
            size="xs"
            variant="default"
            disabled={busy !== null}
            onClick={() => {
              generation.current++
              setTypedPath('')
              void run('import', recent.path)
            }}
          >
            Open
          </Button>
        </section>
      )}

      <p className={classes.footnote}>
        Nothing leaves this computer. The workspace is plain files you can open in any editor.
      </p>

      <Modal
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Add a workspace to this folder?"
        centered
        size={520}
        radius="xl"
        withCloseButton={false}
        classNames={{ content: classes.modalContent, header: classes.modalHeader, title: classes.modalTitle, body: classes.modalBody }}
      >
        {confirm && (
          <>
            <MonoLabel tone="secondary" component="p">
              {confirm.path}
            </MonoLabel>
            <p className={classes.modalText}>
              {confirm.applicationCount > 0
                ? `This folder has ${confirm.applicationCount === 1 ? '1 application folder' : `${confirm.applicationCount} application folders`} but no master profile.`
                : 'This folder already holds other files.'}{' '}
              Huntgry adds these files, skips any that already exist, and never changes or deletes what is there:
            </p>
            <ul className={classes.files}>
              {WORKSPACE_FILES.map((f) => (
                <li key={f.name} className={classes.file}>
                  <IconFileText size={14} aria-hidden />
                  <MonoLabel tone="primary">{f.name}</MonoLabel>
                  <span className={classes.fileNote}>{f.note}</span>
                </li>
              ))}
            </ul>
            <Group justify="flex-end" gap="xs">
              <Button variant="subtle" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                leftSection={<IconCheck size={16} />}
                onClick={() => {
                  const path = confirm.path
                  setConfirm(null)
                  void run('create', path, true)
                }}
              >
                Add workspace files
              </Button>
            </Group>
          </>
        )}
      </Modal>
    </>
  )
}

interface ChoiceCardProps {
  icon: ReactNode
  title: string
  text: string
  /** The screen's one Ember action (filled, with the glow). */
  accent?: boolean
  loading?: boolean
  disabled?: boolean
  onClick(): void
}

/** A whole card that is one button: Create new workspace / Import existing workspace (Figma 15:16, 15:21). */
function ChoiceCard({ icon, title, text, accent, loading, disabled, onClick }: ChoiceCardProps) {
  const id = useId()
  return (
    <button
      type="button"
      className={classes.choice}
      data-accent={accent || undefined}
      disabled={disabled}
      aria-busy={loading || undefined}
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-text`}
      onClick={onClick}
    >
      <span className={classes.choiceIcon} aria-hidden>
        {loading ? <Loader size={20} color="currentColor" /> : icon}
      </span>
      <span id={`${id}-title`} className={classes.choiceTitle}>
        {title}
      </span>
      <span id={`${id}-text`} className={classes.choiceText}>
        {text}
      </span>
    </button>
  )
}
