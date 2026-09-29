import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Container, Group, Stack, Text, TextInput, Title } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import {
  CREATABLE_STATUSES,
  USABLE_STATUSES,
  type PickMode,
  type WorkspaceInspection
} from '@shared/workspace-types'
import { WorkspaceStatus } from './components/WorkspaceStatus'

type Notice = { color: 'green' | 'red' | 'yellow'; text: string } | null

const api = window.huntgry.workspace

/** Startup screen: Create/Import actions, a typed-path field and the inspected workspace card. */
export function App() {
  const [typedPath, setTypedPath] = useState('')
  const [debouncedPath] = useDebouncedValue(typedPath, 300)
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null)
  const [currentPath, setCurrentPath] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState<PickMode | null>(null)
  // Bumped whenever the target changes (typing, picking). Async results from an
  // older generation are dropped, so the card and its buttons always match the
  // current input and never act on a previously inspected folder.
  const generation = useRef(0)

  useEffect(() => {
    const gen = generation.current
    void api.getCurrent().then((current) => {
      if (!current || gen !== generation.current) return
      setInspection(current)
      setCurrentPath(current.path)
    })
  }, [])

  // Live, read-only status for a typed path.
  useEffect(() => {
    if (!debouncedPath.trim()) return
    const gen = generation.current
    api
      .inspect(debouncedPath)
      .then((r) => gen === generation.current && setInspection(r))
      .catch((err: unknown) => {
        if (gen !== generation.current) return
        setInspection(null)
        setNotice({ color: 'red', text: errorText(err) })
      })
  }, [debouncedPath])

  /** Starts a new generation and clears the card so it never shows a stale folder. */
  function onTypedPathChange(value: string) {
    generation.current++
    setTypedPath(value)
    setInspection(null) // hide the old card and its action buttons immediately
    setNotice(null)
  }

  /** Creates a workspace at `path`, unless the target changed meanwhile (`gen`). */
  async function runCreate(path: string, gen: number) {
    const result = await api.create(path)
    if (gen !== generation.current) return
    setInspection(result.inspection)
    if (result.ok) {
      setCurrentPath(result.inspection.path)
      const files = result.created.filter((c) => c !== '.')
      setNotice({ color: 'green', text: `Workspace created. Added ${files.join(', ') || 'nothing new'}.` })
    } else {
      setNotice({ color: 'red', text: result.error ?? 'Could not create workspace.' })
    }
  }

  /** Imports the workspace at `path` and explains why when it is not usable. */
  async function runImport(path: string, gen: number) {
    const result = await api.open(path)
    if (gen !== generation.current) return
    setInspection(result)
    if (USABLE_STATUSES.includes(result.status)) {
      setCurrentPath(result.path)
      setNotice({ color: 'green', text: 'Workspace imported. Nothing inside it was changed.' })
    } else if (CREATABLE_STATUSES.includes(result.status)) {
      setNotice({ color: 'yellow', text: 'No workspace here yet. Use “Create workspace here” to set one up.' })
    } else if (result.status === 'unverified') {
      setNotice({
        color: 'yellow',
        text: 'This folder is too large to verify, so it was not imported. Pick the workspace folder itself.'
      })
    } else {
      setNotice({ color: 'red', text: 'This folder cannot be imported as a Resume Tailor workspace.' })
    }
  }

  /** Runs Create or Import for `path`, or for a folder picked in the native dialog. */
  async function run(mode: PickMode, path?: string) {
    setBusy(mode)
    try {
      const target = path ?? (await api.pickDirectory(mode))
      if (!target) return // picker cancelled: change nothing
      if (path === undefined) {
        // A picked folder replaces whatever was typed, so input and card never disagree.
        generation.current++
        setTypedPath('')
      }
      setNotice(null)
      const gen = generation.current
      await (mode === 'create' ? runCreate(target, gen) : runImport(target, gen))
    } catch (err) {
      setNotice({ color: 'red', text: errorText(err) })
    } finally {
      setBusy(null)
    }
  }

  const canCreateHere = inspection && CREATABLE_STATUSES.includes(inspection.status)
  const canImportHere =
    inspection && USABLE_STATUSES.includes(inspection.status) && inspection.path !== currentPath

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <div>
          <Title order={2}>Huntgry</Title>
          <Text c="dimmed">Set up the working directory for the Claude resume-tailor skill.</Text>
        </div>

        <Group grow>
          <Button size="md" loading={busy === 'create'} disabled={busy !== null} onClick={() => run('create')}>
            Create New Workspace
          </Button>
          <Button
            size="md"
            variant="default"
            loading={busy === 'import'}
            disabled={busy !== null}
            onClick={() => run('import')}
          >
            Import Existing Workspace
          </Button>
        </Group>

        <TextInput
          label="Or type a folder path"
          description="Absolute path or ~/…; a folder that does not exist yet can be created."
          placeholder="~/cv"
          value={typedPath}
          onChange={(e) => onTypedPathChange(e.currentTarget.value)}
        />

        {notice && (
          <Alert color={notice.color} variant="light" role="status">
            {notice.text}
          </Alert>
        )}

        {inspection && (
          <>
            {inspection.path === currentPath && (
              <Text size="sm" c="dimmed">
                Current workspace
              </Text>
            )}
            <WorkspaceStatus inspection={inspection} />
            {(canCreateHere || canImportHere) && (
              <Group>
                {canCreateHere && (
                  <Button variant="light" disabled={busy !== null} onClick={() => run('create', inspection.path)}>
                    Create workspace here
                  </Button>
                )}
                {canImportHere && (
                  <Button variant="light" disabled={busy !== null} onClick={() => run('import', inspection.path)}>
                    Import this workspace
                  </Button>
                )}
              </Group>
            )}
          </>
        )}
      </Stack>
    </Container>
  )
}

/** Readable message for an error thrown across IPC. */
function errorText(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  // ipcRenderer.invoke prefixes main-process errors; keep only the useful part.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
