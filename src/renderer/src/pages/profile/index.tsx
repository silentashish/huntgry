import { useCallback, useEffect, useRef, useState } from 'react'
import { Center, Loader } from '@mantine/core'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
import { api } from '../../api'
import { ProfileEditor } from '../../components/ProfileEditor'
import { useNavigation, type PageParams } from '../../navigation'

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

/** The master profile editor inside the shell; unsaved edits guard navigation away. */
export function ProfilePage({ params, document, initialDraft, onDocumentChange, onSwitchWorkspace, onLeave }: Props) {
  const { setLeaveGuard } = useNavigation()
  const onDirtyChange = useCallback(
    (dirty: boolean) => setLeaveGuard(dirty ? 'You have edits that are not saved to the master profile yet.' : null),
    [setLeaveGuard]
  )
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard])
  // Latest callback without re-running the unmount effect when App re-renders.
  const leave = useRef(onLeave)
  leave.current = onLeave
  useEffect(() => () => leave.current(), [])

  // Other pages can save the profile too (the Dashboard's "I have this"): start from the file, not
  // from the copy loaded at startup. An import draft is shown as is.
  const [ready, setReady] = useState(initialDraft !== undefined)
  const change = useRef(onDocumentChange)
  change.current = onDocumentChange
  useEffect(() => {
    if (ready) return
    let alive = true
    api.profile
      .read()
      .then((fresh) => {
        if (alive && fresh.version !== document.version) change.current(fresh)
      })
      .catch(() => undefined)
      .finally(() => alive && setReady(true))
    return () => {
      alive = false
    }
    // Only on arrival: later document changes come from the editor itself.
  }, [])
  if (!ready) {
    return (
      <Center py="xl">
        <Loader />
      </Center>
    )
  }
  return (
    <ProfileEditor
      key={`${document.path}#${params?.section ?? ''}`}
      document={document}
      initialDraft={initialDraft}
      initialTab={params?.section}
      onDocumentChange={onDocumentChange}
      onSwitchWorkspace={onSwitchWorkspace}
      onDirtyChange={onDirtyChange}
    />
  )
}
