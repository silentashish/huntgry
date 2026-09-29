import { useEffect, useState } from 'react'
import { Center, Container, Group, Image, Loader, Stack, Text, Title } from '@mantine/core'
import { isProfileEmpty, type MasterProfile, type ProfileDocument } from '@shared/master-profile'
import { canImport, type WorkspaceInspection } from '@shared/workspace-types'
import { api, errorText } from './api'
import logo from './assets/logo.svg'
import { ProfileEditor } from './components/ProfileEditor'
import { ProfileSetup } from './components/ProfileSetup'
import { WorkspacePicker } from './components/WorkspacePicker'

type Draft = { profile: MasterProfile; fileName: string; warnings: string[] }
type PickerNotice = { color: 'red' | 'yellow'; text: string; offerCreate?: string }

type View =
  | { name: 'loading' }
  | { name: 'picker'; notice?: PickerNotice }
  | { name: 'setup'; inspection: WorkspaceInspection; doc: ProfileDocument }
  | { name: 'editor'; inspection: WorkspaceInspection; doc: ProfileDocument; draft?: Draft }

/**
 * Flow: pick or create a workspace → (new or empty profile) set it up from a
 * resume or by hand → edit the master profile. The Markdown file in the
 * workspace is the only store; every screen reads it through main.
 */
export function App() {
  const [view, setView] = useState<View>({ name: 'loading' })

  async function open(inspection: WorkspaceInspection, created: boolean) {
    try {
      const doc = await api.profile.read()
      setView(created || isProfileEmpty(doc.profile) ? { name: 'setup', inspection, doc } : { name: 'editor', inspection, doc })
    } catch (err) {
      setView({ name: 'picker', notice: { color: 'red', text: errorText(err) } })
    }
  }

  useEffect(() => {
    void api.workspace
      .getCurrent()
      .then((current) => {
        if (current && canImport(current)) return open(current, false)
        setView({
          name: 'picker',
          notice: current
            ? {
                color: 'yellow',
                text: `The last workspace (${current.path}) no longer has a master profile. Create a new workspace or import another one.`,
                offerCreate: current.status === 'invalid' ? undefined : current.path
              }
            : undefined
        })
      })
      .catch((err: unknown) => setView({ name: 'picker', notice: { color: 'red', text: errorText(err) } }))
  }, [])

  const wide = view.name === 'editor'
  return (
    <Container size={wide ? 960 : 'sm'} py="xl">
      <Stack gap="lg">
        <Group gap="sm" wrap="nowrap">
          <Image src={logo} alt="" w={40} h={40} />
          <div>
            <Title order={2} lh={1.1}>
              Huntgry
            </Title>
            <Text c="dimmed" size="sm">
              {view.name === 'picker'
                ? 'Set up the working directory for the Claude resume-tailor skill.'
                : 'Your master profile: every tailored resume is picked from it.'}
            </Text>
          </div>
        </Group>

        {view.name === 'loading' && (
          <Center py="xl">
            <Loader />
          </Center>
        )}

        {view.name === 'picker' && <WorkspacePicker initialNotice={view.notice ?? null} onOpened={open} />}

        {view.name === 'setup' && (
          <ProfileSetup
            workspacePath={view.inspection.path}
            onImported={(draft) => setView({ name: 'editor', inspection: view.inspection, doc: view.doc, draft })}
            onManual={() => setView({ name: 'editor', inspection: view.inspection, doc: view.doc })}
          />
        )}

        {view.name === 'editor' && (
          <ProfileEditor
            key={view.doc.path}
            document={view.doc}
            initialDraft={view.draft}
            onDocumentChange={(doc) => setView({ ...view, doc, draft: undefined })}
            onSwitchWorkspace={() => setView({ name: 'picker' })}
          />
        )}
      </Stack>
    </Container>
  )
}
