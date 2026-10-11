import { useEffect, useState, type ReactNode } from 'react'
import { Button, VisuallyHidden } from '@mantine/core'
import { IconArrowRight, IconBriefcase, IconCheck, IconPawFilled, IconPlus, IconSparkles, IconUser } from '@tabler/icons-react'
import { api } from '../../api'
import { EmptyState } from '../../components/ui'
import { useNavigation } from '../../navigation'
import classes from './dashboard.module.css'

/**
 * The first-hunt Dashboard (Figma Dashboard — Empty): three steps, then "No applications yet".
 * `profileReady`: the master profile has content (`null` while it loads).
 */
export function FirstHunt({ profileReady }: { profileReady: boolean | null }) {
  const { navigate } = useNavigation()
  const [savedJobs, setSavedJobs] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    api.jobs.list().then(
      (jobs) => alive && setSavedJobs(jobs.length),
      () => undefined
    )
    return () => {
      alive = false
    }
  }, [])

  return (
    <>
      <div className={classes.steps}>
        <Step
          n={1}
          done={profileReady === true}
          icon={<IconUser size={18} />}
          title="Fill the master profile"
          text="Import your resume or type it in. It is the only store: every tailored resume is picked from it."
          action={
            profileReady ? (
              <Button variant="default" size="xs" leftSection={<IconCheck size={14} />} onClick={() => navigate('profile')}>
                Profile is ready
              </Button>
            ) : (
              <Button variant="secondary" size="xs" rightSection={<IconArrowRight size={14} />} onClick={() => navigate('profile')}>
                Open the profile
              </Button>
            )
          }
        />
        <Step
          n={2}
          done={!!savedJobs}
          icon={<IconBriefcase size={18} />}
          title="Sniff out jobs"
          text={
            savedJobs
              ? `${savedJobs} job${savedJobs === 1 ? '' : 's'} saved, ranked by how strongly each one smells like you.`
              : 'Paste a posting URL or the description. Huntgry ranks each one by how strongly it smells like you.'
          }
          action={
            <Button variant="secondary" size="xs" rightSection={<IconArrowRight size={14} />} onClick={() => navigate('jobs')}>
              {savedJobs ? 'Open Jobs' : 'Add a job'}
            </Button>
          }
        />
        <Step
          n={3}
          done={false}
          icon={<IconSparkles size={18} />}
          title="Tailor and apply"
          text="Run Claude, Codex or Antigravity on a job. Review the wording, then fill the form in the in-app browser."
          action={
            <Button variant="secondary" size="xs" rightSection={<IconArrowRight size={14} />} onClick={() => navigate('tailor')}>
              Tailor a job
            </Button>
          }
        />
      </div>

      <div className={classes.emptyCard}>
        <EmptyState
          icon={<IconPawFilled size={34} />}
          title="No applications yet"
          description={
            <>
              Every resume the skill builds lands in this workspace as <span className={classes.code}>role/company/job-id/</span> and
              shows up here with its build result, previews and tracking.
            </>
          }
          actions={
            <>
              <Button leftSection={<IconPlus size={16} />} onClick={() => navigate('jobs')}>
                Add a job
              </Button>
              <Button variant="default" leftSection={<IconSparkles size={16} />} onClick={() => navigate('tailor')}>
                Tailor for a job
              </Button>
            </>
          }
        />
      </div>
    </>
  )
}

function Step({ n, done, icon, title, text, action }: { n: number; done: boolean; icon: ReactNode; title: string; text: string; action: ReactNode }) {
  return (
    <div className={classes.step} data-done={done || undefined}>
      <div className={classes.stepBadges} aria-hidden>
        <span className={classes.stepNumber}>{done ? <IconCheck size={16} /> : n}</span>
        {icon}
      </div>
      <h3 className={classes.stepTitle}>
        {done && <VisuallyHidden>Done: </VisuallyHidden>}
        {title}
      </h3>
      <p className={classes.stepText}>{text}</p>
      {action}
    </div>
  )
}
