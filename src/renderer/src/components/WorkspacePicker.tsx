import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Code, Group, List, Modal, Stack, Text, TextInput } from '@mantine/core'
import { useDebouncedValue } from '@mantine/hooks'
import { canImport, createMode, type PickMode, type WorkspaceInspection } from '@shared/workspace-types'
import { api, errorText } from '../api'
import { WorkspaceStatus } from './WorkspaceStatus'

type Notice = { color: 'green' | 'red' | 'yellow'; text: string; offerCreate?: string } | null

interface Props {
  /** Called once a workspace with a master profile is open. `created` is true right after Create. */
  onOpened(inspection: WorkspaceInspection, created: boolean): void
  /** Shown on arrival, e.g. when the remembered workspace lost its master profile. */
  initialNotice?: Notice
}

export function WorkspacePicker({ onOpened, initialNotice = null }: Props) {
  const [typedPath, setTypedPath] = useState('')
  const [debouncedPath] = useDebouncedValue(typedPath, 300)
  const [inspection, setInspection] = useState<WorkspaceInspection | null>(null)
  const [notice, setNotice] = useState<Notice>(initialNotice)
  const [busy, setBusy] = useState<PickMode | null>(null)
  const [confirm, setConfirm] = useState<WorkspaceInspection | null>(null)
  // Bumped whenever the target changes (typing, picking). Async results from an
  // older generation are dropped, so the card and its buttons always match the
  // current input and never act on a previously inspected folder.
  const generation = useRef(0)

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

  const canCreateHere = inspection && createMode(inspection) !== null
  const canImportHere = inspection && canImport(inspection)

  return (
    <Stack gap="lg">
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
          <Stack gap="xs">
            <Text size="sm">{notice.text}</Text>
            {notice.offerCreate && (
              <Group>
                <Button
                  size="xs"
                  disabled={busy !== null}
                  onClick={() => run('create', notice.offerCreate)}
                >
                  Create workspace here
                </Button>
              </Group>
            )}
          </Stack>
        </Alert>
      )}

      {inspection && (
        <>
          <WorkspaceStatus inspection={inspection} />
          {(canCreateHere || canImportHere) && !notice?.offerCreate && (
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

      <Modal
        opened={confirm !== null}
        onClose={() => setConfirm(null)}
        title="Add a workspace to this folder?"
        centered
      >
        {confirm && (
          <Stack gap="sm">
            <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {confirm.path}
            </Code>
            <Text size="sm">
              {confirm.applicationCount > 0
                ? `This folder has ${confirm.applicationCount} application folder(s) but no master profile.`
                : 'This folder already holds other files.'}{' '}
              Huntgry adds these files, skips any that already exist, and never changes or deletes what is there:
            </Text>
            <List size="sm">
              <List.Item>
                <Code>master-profile.md</Code>: your master profile
              </List.Item>
              <List.Item>
                <Code>cover-letter.md</Code>: optional base cover letter
              </List.Item>
              <List.Item>
                <Code>CLAUDE.md</Code>: points the resume-tailor skill at this folder
              </List.Item>
            </List>
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setConfirm(null)}>
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const path = confirm.path
                  setConfirm(null)
                  void run('create', path, true)
                }}
              >
                Add workspace files
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  )
}
