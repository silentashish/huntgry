import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Button, Center, SegmentedControl } from '@mantine/core'
import { IconBookmark, IconCompass, IconPlus } from '@tabler/icons-react'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { PageHeader } from '../../components/ui'
import { useNavigation, type JobsTab, type PageParams } from '../../navigation'
import { AddJobModal } from './AddJobModal'
import { DiscoverTab } from './discover/DiscoverTab'
import { mergeJobs } from './merge'
import { SavedTab } from './SavedTab'
import { jobsTab, savedCount, type TabHeader } from './tabs'

/**
 * The Jobs page (#189: Explore merged into Jobs) with two tabs, Discover · Saved, picked by `params.tab` so each is
 * deep-linkable (the Profile page's view switch, #95). Discover is Jobright's daily list (#142), Saved the jobs you
 * keep (#78). Both share the saved list, so a Discover row saved a moment ago reads "Saved ✓" and is on Saved, and
 * one "Add job" dialog (a link or a posting's text) on both. Huntgry does not search job boards itself (#78).
 */
export function JobsPage({ params }: { params?: PageParams['jobs'] }) {
  const { navigate } = useNavigation()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [openId, setOpenId] = useState<string | null>(params?.openId ?? null)
  /**
   * The tab on screen once known. Without `tab` or `openId` the page opens on Saved when there is a saved job and on
   * Discover when there is none; that choice then stays, so saving the first job on Discover does not switch tabs.
   */
  const [pinned, setPinned] = useState<JobsTab | null>(null)

  useEffect(() => {
    api.jobs.list().then(setJobs, (err) => setError(errorText(err)))
  }, [])

  // Every navigation here (a tab, a saved job to open) is followed, also while the page stays on screen; one that
  // names no job closes the drawer, so ⌘K's "Jobs → Saved" never reopens the job looked at before.
  useEffect(() => {
    setPinned(null)
    setOpenId(params?.openId ?? null)
  }, [params])

  const tab = pinned ?? jobsTab(params, jobs ? savedCount(jobs) : null)
  useEffect(() => {
    if (pinned === null && tab !== null) setPinned(tab)
  }, [pinned, tab])

  const upsert = (list: Job[]) => setJobs((cur) => mergeJobs(cur ?? [], list))
  const showTab = (t: JobsTab) => navigate('jobs', { tab: t })
  /** Saved, with `job`'s drawer open: Discover's "Saved ✓", and a job just added. */
  const openSaved = (job: Job) => navigate('jobs', { tab: 'saved', openId: job.id })

  const header = ({ eyebrow, subtitle, actions }: TabHeader) => (
    <>
      <PageHeader
        eyebrow={eyebrow}
        title="Jobs"
        subtitle={subtitle}
        actions={
          <>
            {actions}
            <Button variant="default" leftSection={<IconPlus size={16} />} onClick={() => setAddOpen(true)}>
              Add job
            </Button>
          </>
        }
      />
      <SegmentedControl
        aria-label="Jobs view"
        style={{ alignSelf: 'flex-start' }}
        value={tab ?? 'saved'}
        onChange={(v) => showTab(v as JobsTab)}
        data={[
          { value: 'discover', label: <TabLabel icon={<IconCompass size={14} aria-hidden />} text="Discover" /> },
          {
            value: 'saved',
            label: <TabLabel icon={<IconBookmark size={14} aria-hidden />} text={jobs ? `Saved (${savedCount(jobs)})` : 'Saved'} />
          }
        ]}
      />
      {error && (
        <Alert color="danger" variant="light" title="The saved jobs could not be read" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
    </>
  )

  return (
    <>
      {tab === 'discover' ? (
        <DiscoverTab saved={jobs ?? []} onSaved={(j) => upsert([j])} onOpenSaved={openSaved} header={header} />
      ) : (
        // While the saved jobs load (and no tab was asked for), Saved draws its loader.
        <SavedTab
          jobs={error ? [] : jobs}
          onUpsert={upsert}
          openId={openId}
          onOpen={setOpenId}
          onDiscover={() => showTab('discover')}
          header={header}
        />
      )}
      <AddJobModal
        opened={addOpen}
        onClose={() => setAddOpen(false)}
        onSaved={(j) => {
          upsert([j])
          setAddOpen(false)
          openSaved(j)
        }}
      />
    </>
  )
}

function TabLabel({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <Center inline style={{ gap: 6 }}>
      {icon}
      <span>{text}</span>
    </Center>
  )
}
