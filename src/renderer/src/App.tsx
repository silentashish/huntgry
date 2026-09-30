import { useEffect, useState } from 'react'
import { Center, Container, Group, Image, Loader, Stack, Text, Title } from '@mantine/core'
import { isProfileEmpty, type MasterProfile, type ProfileDocument } from '@shared/master-profile'
import { canImport, type WorkspaceInspection } from '@shared/workspace-types'
import { api, errorText } from './api'
import logo from './assets/logo.svg'
import { ProfileSetup } from './components/ProfileSetup'
import { AppLayout } from './components/shell/AppLayout'
import { WorkspacePicker } from './components/WorkspacePicker'
import { locationOf, paramsFor, type Location } from './navigation'
import { BrowserPage } from './pages/browser'
import { DashboardPage } from './pages/dashboard'
import { GraphPage } from './pages/graph'
import { JobsPage } from './pages/jobs'
import { ProfilePage } from './pages/profile'
import { SettingsPage } from './pages/settings'
import { TailorPage } from './pages/tailor'

type Draft = { profile: MasterProfile; fileName: string; warnings: string[] }
type PickerNotice = { color: 'red' | 'yellow'; text: string; offerCreate?: string }

type View =
  | { name: 'loading' }
  | { name: 'picker'; notice?: PickerNotice }
  | { name: 'setup'; inspection: WorkspaceInspection; doc: ProfileDocument }
  | { name: 'shell'; inspection: WorkspaceInspection; doc: ProfileDocument; draft?: Draft; start?: Location }

/**
 * Flow: pick or create a workspace → (new or empty profile) set it up from a
 * resume or by hand → the app shell with its pages. The Markdown file in the
 * workspace is the only store; every screen reads it through main.
 */
export function App() {
  const [view, setView] = useState<View>({ name: 'loading' })

  async function open(inspection: WorkspaceInspection, created: boolean) {
    try {
      const doc = await api.profile.read()
      setView(created || isProfileEmpty(doc.profile) ? { name: 'setup', inspection, doc } : { name: 'shell', inspection, doc })
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

  if (view.name === 'shell') {
    const switchWorkspace = () => setView({ name: 'picker' })
    return (
      <AppLayout
        key={view.inspection.path}
        workspacePath={view.inspection.path}
        initialLocation={view.start}
        onSwitchWorkspace={switchWorkspace}
      >
        {(location) => {
          switch (location.page) {
            case 'dashboard':
              return <DashboardPage />
            case 'jobs':
              return <JobsPage />
            case 'browser':
              return <BrowserPage params={paramsFor(location, 'browser')} />
            case 'tailor':
              return <TailorPage params={paramsFor(location, 'tailor')} />
            case 'graph':
              return <GraphPage params={paramsFor(location, 'graph')} />
            case 'settings':
              return <SettingsPage />
            case 'profile':
              return (
                <ProfilePage
                  params={paramsFor(location, 'profile')}
                  document={view.doc}
                  initialDraft={view.draft}
                  onDocumentChange={(doc) => setView({ ...view, doc, draft: undefined })}
                  onLeave={() => setView((v) => (v.name === 'shell' && v.draft ? { ...v, draft: undefined } : v))}
                  onSwitchWorkspace={switchWorkspace}
                />
              )
          }
        }}
      </AppLayout>
    )
  }

  return (
    <Container size="sm" py="xl">
      <Stack gap="lg">
        <Group gap="sm" wrap="nowrap">
          <Image src={logo} alt="" w={40} h={40} />
          <div>
            <Title order={2} lh={1.1}>
              Huntgry
            </Title>
            <Text c="dimmed" size="sm">
              {view.name === 'setup'
                ? 'Your master profile: every tailored resume is picked from it.'
                : 'Set up the working directory for the Claude resume-tailor skill.'}
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
            onImported={(draft) =>
              setView({ name: 'shell', inspection: view.inspection, doc: view.doc, draft, start: locationOf('profile') })
            }
            onManual={() => setView({ name: 'shell', inspection: view.inspection, doc: view.doc, start: locationOf('profile') })}
          />
        )}
      </Stack>
    </Container>
  )
}
