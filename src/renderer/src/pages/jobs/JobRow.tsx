import { Checkbox } from '@mantine/core'
import { IconCheck, IconEyeOff, IconFlame } from '@tabler/icons-react'
import type { RowScore } from '@shared/explore-score'
import type { JobScore } from '@shared/job-relevance'
import type { Job } from '@shared/jobs-types'
import type { QueueItem } from '@shared/queue-types'
import { initialsOf, MonoLabel, ScoreRing, StatusPill } from '../../components/ui'
import { QUEUE_STATUS_LABEL } from '../tailor/status'
import { ago, jobMeta, LIVE_QUEUE_STATUSES, QUEUE_STATUS_TONE, RELEVANT_LEFT_OUT, SOURCE_LABEL, sponsorshipPill, workplacePill } from './labels'
import { MatchBadge } from './MatchBadge'
import classes from './jobs.module.css'

interface Props {
  job: Job
  /** The match score (#149), the number the row shows (#189); absent while the profile loads. */
  match?: RowScore
  /** The relevance (#73): why the job fits, or why Relevant leaves it out; absent when the profile has no title. */
  relevance?: JobScore
  /** The job's unfinished queue item, if any. */
  queueItem?: QueueItem
  selected: boolean
  selectable: boolean
  onToggle(): void
  onOpen(): void
}

/**
 * One saved job (Figma Jobs — Relevant, JobList card): the match score badge (#189: as on Discover), title with its
 * queue / tailored state, company · location · pay, the start of the posting, why it fits, and the source /
 * workplace / visa pills.
 */
export function JobRow({ job, match, relevance, queueItem, selected, selectable, onToggle, onOpen }: Props) {
  const workplace = workplacePill(job)
  const visa = sponsorshipPill(job)
  return (
    <li
      className={classes.job}
      data-selected={(selected && selectable) || undefined}
      data-dismissed={job.dismissed || undefined}
      aria-label={job.title}
      onClick={onOpen}
    >
      <Checkbox
        className={classes.jobCheck}
        size="xs"
        aria-label={`Select ${job.title}`}
        checked={selected && selectable}
        disabled={!selectable}
        // Ticking selects the job; it must not open the drawer.
        onClick={(e) => e.stopPropagation()}
        onChange={onToggle}
      />
      <div className={classes.score}>
        {match ? (
          <MatchBadge score={match} />
        ) : (
          <ScoreRing mode="initial" letter={initialsOf(job.company || job.title)} aria-label="No match score yet" />
        )}
      </div>
      <div className={classes.jobBody}>
        <div className={classes.titleRow}>
          {/* The row opens on click; the title is its keyboard handle. */}
          <button type="button" className={classes.title}>
            {job.title}
          </button>
          {queueItem && (
            <StatusPill tone={QUEUE_STATUS_TONE[queueItem.status]} dot={LIVE_QUEUE_STATUSES.includes(queueItem.status)}>
              {QUEUE_STATUS_LABEL[queueItem.status].label}
            </StatusPill>
          )}
          {job.tailoredAt && (
            <StatusPill tone="success" leftSection={<IconCheck size={12} stroke={2.5} />}>
              Tailored
            </StatusPill>
          )}
        </div>
        {jobMeta(job) && <p className={classes.meta}>{jobMeta(job)}</p>}
        {job.description && <p className={classes.description}>{job.description}</p>}
        {relevance?.excluded && (
          <p className={classes.excluded}>
            <IconEyeOff size={14} aria-hidden />
            {RELEVANT_LEFT_OUT}: {relevance.excluded}
          </p>
        )}
        {relevance && relevance.reasons.length > 0 && (
          <div className={classes.reasons}>
            <IconFlame size={14} aria-hidden />
            <ul aria-label="Why it fits">
              {relevance.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className={classes.side}>
        <StatusPill>{SOURCE_LABEL[job.source]}</StatusPill>
        {workplace && <StatusPill tone={workplace.tone}>{workplace.label}</StatusPill>}
        {visa && <StatusPill tone={visa.tone}>{visa.label}</StatusPill>}
        {job.postedAt && <MonoLabel size="xs">{ago(job.postedAt)}</MonoLabel>}
      </div>
    </li>
  )
}
