import { useCallback, useEffect, useRef } from 'react'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
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
