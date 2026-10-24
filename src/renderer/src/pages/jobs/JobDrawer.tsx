import { useState, type ReactNode } from 'react'
import { ActionIcon, Alert, Button, Drawer } from '@mantine/core'
import {
  IconCloudDownload,
  IconEyeOff,
  IconInfoCircle,
  IconRefresh,
  IconRestore,
  IconSparkles,
  IconWorld,
  IconX
} from '@tabler/icons-react'
import type { JobScore } from '@shared/job-relevance'
import { canFetchDetails, canRefetchDetails, JOBRIGHT_SUMMARY_NOTE, type Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { KpiTile, MonoLabel, ScoreRing, StatusPill, toneStyle, type UiTone } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { jobFacts, jobMeta, scentDisplay, SOURCE_LABEL, sponsorshipPill, workplacePill } from './labels'
import classes from './jobs.module.css'

interface Props {
  job: Job | null
  /** The job's Scent score (the Jobs page passes it; without one the drawer leaves the score box out). */
  score?: JobScore
  onClose(): void
  onChange(job: Job): void
  /** Resolves once the job has been handed to the Tailor page (after fetching its full posting, when possible). */
  onTailor(job: Job): Promise<void>
}

/** One job: the Scent score and why, what to do with it, its facts and the full description (Figma Jobs — Job drawer). */
export function JobDrawer({ job, score, onClose, onChange, onTailor }: Props) {
  const { navigate } = useNavigation()
  const [busy, setBusy] = useState<'details' | 'dismiss' | 'tailor' | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function act(kind: 'details' | 'dismiss', fn: () => Promise<Job>) {
    setBusy(kind)
    setError(null)
    try {
      onChange(await fn())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(null)
    }
  }

  async function tailor(job: Job) {
    setBusy('tailor')
    setError(null)
    try {
      await onTailor(job)
    } finally {
      setBusy(null)
    }
  }

  const close = () => {
    setError(null)
    onClose()
  }

  return (
    <Drawer.Root opened={job !== null} onClose={close} position="right" size={600}>
      <Drawer.Overlay />
      <Drawer.Content>
        {job && (
          <>
            <Drawer.Header className={classes.drawerHeader}>
              <div className={classes.drawerHeading}>
                <Pills job={job} />
                <Drawer.Title className={classes.drawerTitle}>{job.title}</Drawer.Title>
                <p className={classes.meta} style={{ whiteSpace: 'normal' }}>
                  {jobMeta(job)}
                  {job.postedAt && ` · posted ${new Date(job.postedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}`}
                  {job.commitment?.length ? ` · ${job.commitment.join(', ')}` : ''}
                </p>
              </div>
              <ActionIcon variant="default" size="lg" aria-label="Close" onClick={close}>
                <IconX size={16} />
              </ActionIcon>
            </Drawer.Header>
            <Drawer.Body className={classes.drawerBody}>
              {score && <ScentBox score={score} />}
              <div className={classes.actions}>
                <Button
                  variant="primary"
                  leftSection={<IconSparkles size={16} />}
                  loading={busy === 'tailor'}
                  disabled={busy !== null && busy !== 'tailor'}
                  onClick={() => void tailor(job)}
                >
                  Tailor resume
                </Button>
                <Button
                  variant="default"
                  disabled={!job.url}
                  onClick={() => navigate('browser', { url: job.url })}
                  leftSection={<IconWorld size={16} />}
                >
                  Open posting
                </Button>
                {/* An Indeed job can still be fetched through a copy of it found on another board; Jobright's summary
                    can be swapped for the employer's posting once that page has one (#148). */}
                {canRefetchDetails(job) && (
                  <Button
                    variant="subtle"
                    leftSection={<IconCloudDownload size={16} />}
                    loading={busy === 'details'}
                    disabled={busy === 'tailor'}
                    onClick={() => act('details', () => api.jobs.fetchDetails(job.id))}
                  >
                    Fetch full description
                  </Button>
                )}
                <Button
                  variant="subtle"
                  leftSection={job.dismissed ? <IconRestore size={16} /> : <IconEyeOff size={16} />}
                  loading={busy === 'dismiss'}
                  disabled={busy === 'tailor'}
                  onClick={() => act('dismiss', () => api.jobs.update(job.id, { dismissed: !job.dismissed }))}
                >
                  {job.dismissed ? 'Restore' : 'Dismiss'}
                </Button>
              </div>
              {busy === 'tailor' && canFetchDetails(job) && (
                <Notice tone="trail" icon={<IconRefresh size={18} />}>
                  Fetching the full posting from the employer’s page before tailoring…
                </Notice>
              )}
              {error && (
                <Alert color="warning" variant="light" withCloseButton onClose={() => setError(null)}>
                  {error}
                </Alert>
              )}
              {job.descriptionSource === 'jobright-summary' && (
                <Notice tone="info" icon={<IconInfoCircle size={18} />}>
                  {JOBRIGHT_SUMMARY_NOTE}
                </Notice>
              )}
              {!job.descriptionComplete && (
                <Notice tone="info" icon={<IconInfoCircle size={18} />}>
                  {job.source === 'indeed'
                    ? 'Indeed search results include only a snippet, and its job pages need a human check. Tailor resume sends this snippet with the job’s details; for a better resume, open the posting and paste the full description on the Tailor page (or with “Paste a job”).'
                    : job.source === 'jobright'
                      ? 'Jobright’s list gives only the title, company and location. Fetch full description (or Tailor resume) reads the posting from Jobright’s page; if Jobright asks for a human check, open the posting and paste the description.'
                      : 'This is the job board’s summary, not the full posting. Tailor resume fetches the full description from the employer’s page first, and falls back to this summary if it cannot.'}
                </Notice>
              )}
              <Facts job={job} />
              <MonoLabel component="div">{job.descriptionComplete ? 'Description' : 'Summary'}</MonoLabel>
              <p className={classes.postingText}>{job.description || 'No description.'}</p>
              {job.tags.length > 0 && (
                <div className={classes.tags}>
                  {job.tags.map((t) => (
                    <StatusPill key={t} variant="outline">
                      {t}
                    </StatusPill>
                  ))}
                </div>
              )}
            </Drawer.Body>
          </>
        )}
      </Drawer.Content>
    </Drawer.Root>
  )
}

function Pills({ job }: { job: Job }) {
  const workplace = workplacePill(job)
  const visa = sponsorshipPill(job)
  return (
    <div className={classes.pills}>
      <StatusPill>{SOURCE_LABEL[job.source]}</StatusPill>
      {workplace && <StatusPill tone={workplace.tone}>{workplace.label}</StatusPill>}
      {visa && <StatusPill tone={visa.tone}>{visa.label}</StatusPill>}
      {job.tailoredAt && <StatusPill tone="success">Sent to tailor</StatusPill>}
      {job.dismissed && <StatusPill>Dismissed</StatusPill>}
    </div>
  )
}

/** "Strong scent" with the score and every reason it fits; a job Relevant leaves out says why, in neutral. */
function ScentBox({ score }: { score: JobScore }) {
  const scent = scentDisplay(score)
  return (
    <div className={classes.scent} style={toneStyle(scent.tone)} data-tone={scent.tone}>
      <ScoreRing value={score.score} size="lg" tone={scent.tone} />
      <div className={classes.scentText}>
        <span className={classes.scentLabel}>{scent.label}</span>
        {scent.excluded && (
          <p className={classes.scentExcluded}>
            <IconEyeOff size={14} aria-hidden />
            {scent.excluded}
          </p>
        )}
        <p className={classes.scentReasons}>
          {score.reasons.length > 0 ? score.reasons.join(' · ') : 'Nothing in the posting matches your master profile yet.'}
        </p>
      </div>
    </div>
  )
}

function Notice({ tone, icon, children }: { tone: UiTone; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={classes.notice} style={toneStyle(tone)}>
      <span className={classes.noticeIcon}>{icon}</span>
      <p>{children}</p>
    </div>
  )
}

function Facts({ job }: { job: Job }) {
  const facts = jobFacts(job)
  if (facts.length === 0) return null
  return (
    <div className={classes.facts}>
      {facts.map((f) => (
        <KpiTile key={f.label} size="sm" label={f.label} value={f.value} />
      ))}
    </div>
  )
}
