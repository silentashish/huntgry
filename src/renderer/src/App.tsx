import { useEffect, useState } from 'react'
import { Loader } from '@mantine/core'
import { isProfileEmpty, type MasterProfile, type ProfileDocument } from '@shared/master-profile'
import { canImport, type WorkspaceInspection } from '@shared/workspace-types'
import { api, errorText } from './api'
import { FirstRunLayout } from './components/first-run/FirstRunLayout'
import firstRun from './components/first-run/first-run.module.css'
import { ProfileSetup } from './components/ProfileSetup'
import { AppLayout } from './components/shell/AppLayout'
import { WorkspacePicker } from './components/WorkspacePicker'
import { locationOf, paramsFor, type Location } from './navigation'
import { BoardPage } from './pages/board'
import { BrowserPage } from './pages/browser'
import { DashboardPage } from './pages/dashboard'
import { ExplorePage } from './pages/explore'
import { JobsPage } from './pages/jobs'
import { ProfilePage } from './pages/profile'
import { ReviewPage } from './pages/review'
import { SettingsPage } from './pages/settings'
import { PairingPrompt } from './pages/settings/PairingPrompt'
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
      <>
        {/* A phone that scanned the pairing code is asked about on every page (#37). */}
        <PairingPrompt />
        <AppLayout
          key={view.inspection.path}
          workspacePath={view.inspection.path}
          initialLocation={view.start}
          profile={view.doc.profile}
          onSwitchWorkspace={switchWorkspace}
        >
          {(location) => {
            // `graph` never gets here: navigation sends it to Profile's graph view (#108).
            switch (location.page) {
              case 'dashboard':
                return <DashboardPage />
              case 'board':
                return <BoardPage params={paramsFor(location, 'board')} />
              case 'jobs':
                return <JobsPage key={paramsFor(location, 'jobs')?.reload} openId={paramsFor(location, 'jobs')?.openId} />
              case 'explore':
                return <ExplorePage />
              case 'browser':
                return <BrowserPage params={paramsFor(location, 'browser')} />
              case 'tailor':
                return <TailorPage params={paramsFor(location, 'tailor')} />
              case 'review':
                return <ReviewPage params={paramsFor(location, 'review')} />
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
      </>
    )
  }

  // First run (#117): loading, the workspace picker and the profile setup step.
  return (
    <FirstRunLayout
      width={view.name === 'setup' ? 'setup' : 'picker'}
      subtitle={
        view.name === 'loading'
          ? undefined
          : view.name === 'setup'
            ? 'Your master profile: every tailored resume is picked from it. Nothing is written until you save.'
            : (
                <>
                  Hunt jobs like a hungry hound. First, pick the den: the folder the{' '}
                  <span style={{ whiteSpace: 'nowrap' }}>resume-tailor</span> skill works in.
                </>
              )
      }
    >
      {view.name === 'loading' && (
        <div className={firstRun.loading}>
          <Loader size="sm" aria-label="Opening your workspace" />
        </div>
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
    </FirstRunLayout>
  )
}
