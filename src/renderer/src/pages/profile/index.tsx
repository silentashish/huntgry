import { useCallback, useEffect } from 'react'
import type { MasterProfile, ProfileDocument } from '@shared/master-profile'
import { ProfileEditor } from '../../components/ProfileEditor'
import { useNavigation, type PageParams } from '../../navigation'

interface Props {
  params: PageParams['profile']
  document: ProfileDocument
  initialDraft?: { profile: MasterProfile; fileName: string; warnings: string[] }
  onDocumentChange(doc: ProfileDocument): void
  onSwitchWorkspace(): void
}

/** The master profile editor inside the shell; unsaved edits guard navigation away. */
export function ProfilePage({ params, document, initialDraft, onDocumentChange, onSwitchWorkspace }: Props) {
  const { setLeaveGuard } = useNavigation()
  const onDirtyChange = useCallback(
    (dirty: boolean) => setLeaveGuard(dirty ? 'You have edits that are not saved to the master profile yet.' : null),
    [setLeaveGuard]
  )
  useEffect(() => () => setLeaveGuard(null), [setLeaveGuard])
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
