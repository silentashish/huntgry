import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Center, Group, Loader, Stack, Text } from '@mantine/core'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { ProfileEditor } from '../../components/ProfileEditor'
import { leaveMessage } from '../../components/profile/changes'
import { PageHeader } from '../../components/ui'
import { NavigationContext, useNavigation, type Navigation, type PageParams, type ProfileView } from '../../navigation'
import { GraphView, SkillsView, useKnowledgeState } from './KnowledgeViews'

const EYEBROW: Record<ProfileView, string> = {
  editor: 'The single source of truth for every resume',
  graph: 'Your experience as a graph, with the jobs you saved laid over it',
  skills: 'Every skill, its evidence and the jobs asking for it'
}

interface Props {
  params: PageParams['profile']
  document: ProfileDocument
  initialDraft?: { profile: MasterProfile; fileName: string; warnings: string[] }
  onDocumentChange(doc: ProfileDocument): void
  onSwitchWorkspace(): void
  /**
   * The page is going away. Leaving is only possible once unsaved work was
   * saved or explicitly discarded, so the owner drops `initialDraft` here and
   * a later visit starts from the file instead of the discarded import.
   */
  onLeave(): void
}

/**
 * The Profile page (#95: Profile absorbs the Knowledge graph): the master profile with three
 * views, Editor · Knowledge graph · Skills, picked by `params.view` so each is deep-linkable.
 * Unsaved edits guard navigation away from the page, not between its views.
 */
export function ProfilePage({ params, document, initialDraft, onDocumentChange, onSwitchWorkspace, onLeave }: Props) {
  const outer = useNavigation()
  const view: ProfileView = params?.view ?? 'editor'

  // The leave guard, remembered so moves inside the page can pass it (the draft survives them).
  const guard = useRef<string | null>(null)
  const { setLeaveGuard } = outer
  const setGuard = useCallback(
    (message: string | null) => {
      guard.current = message
      setLeaveGuard(message)
    },
    [setLeaveGuard]
  )
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard])
  const nav = useMemo<Navigation>(
    () => ({
      location: outer.location,
      setLeaveGuard: setGuard,
      navigate: (page, ...rest) => {
        if (page !== 'profile' || guard.current === null) return outer.navigate(page, ...rest)
        // Switching views or sections (the graph's "Edit in master profile") stays on this page.
        const message = guard.current
        setLeaveGuard(null)
        outer.navigate(page, ...rest)
        setLeaveGuard(message)
      }
    }),
    [outer, setGuard, setLeaveGuard]
  )
  const file = document.path.split(/[\\/]/).pop() ?? document.path
  const onUnsavedChange = useCallback((fields: number) => setGuard(fields > 0 ? leaveMessage(fields, file) : null), [setGuard, file])

  // Latest callback without re-running the unmount effect when App re-renders.
  const leave = useRef(onLeave)
  leave.current = onLeave
  useEffect(() => () => leave.current(), [])

  // Other pages can save the profile too (the Dashboard's "I have this"): start from the file, not
  // from the copy loaded at startup. An import draft is shown as is.
  const [ready, setReady] = useState(initialDraft !== undefined)
  const [readError, setReadError] = useState<string | null>(null)
  const [attempt, setAttempt] = useState(0)
  const change = useRef(onDocumentChange)
  change.current = onDocumentChange
  useEffect(() => {
    if (ready) return
    let alive = true
    setReadError(null)
    api.profile
      .read()
      .then((fresh) => {
        if (!alive) return
        if (fresh.version !== document.version) change.current(fresh)
        setReady(true)
      })
      // Opening the cached copy would lead to edits the save then refuses; say so and offer a retry.
      .catch((e) => alive && setReadError(errorText(e)))
    return () => {
      alive = false
    }
    // Only on arrival (and on retry): later document changes come from the editor itself.
  }, [attempt])

  const showView = useCallback((next: ProfileView) => nav.navigate('profile', { view: next }), [nav])

  return (
    <NavigationContext.Provider value={nav}>
      <Stack gap="lg">
        <PageHeader eyebrow={EYEBROW[view]} title="Profile" />
        {readError ? (
          <Alert color="red" variant="light" title="Could not read master-profile.md">
            <Text size="sm">{readError}</Text>
            <Group mt="sm">
              <Button size="xs" variant="light" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </Group>
          </Alert>
        ) : !ready ? (
          <Center py="xl">
            <Loader />
          </Center>
        ) : (
          <ProfileEditor
            key={document.path}
            document={document}
            initialDraft={initialDraft}
            section={params?.section}
            sectionRequest={params}
            onDocumentChange={onDocumentChange}
            onSwitchWorkspace={onSwitchWorkspace}
            onUnsavedChange={onUnsavedChange}
            view={view}
            onViewChange={showView}
          >
            {view !== 'editor' && <KnowledgeArea view={view} params={params} onOpenEditor={() => showView('editor')} />}
          </ProfileEditor>
        )}
      </Stack>
    </NavigationContext.Provider>
  )
}

/**
 * The Knowledge graph and Skills views. Mounted only while one of them is shown (the graph is
 * read when it opens, so a save in the editor shows up); between the two it keeps the selected
 * node and the jobs overlay.
 */
function KnowledgeArea({ view, params, onOpenEditor }: { view: 'graph' | 'skills'; params: PageParams['profile']; onOpenEditor(): void }) {
  const state = useKnowledgeState(params?.nodeId, params)
  return view === 'graph' ? <GraphView state={state} onOpenEditor={onOpenEditor} /> : <SkillsView state={state} onOpenEditor={onOpenEditor} />
}
