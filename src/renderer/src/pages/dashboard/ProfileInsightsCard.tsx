import { useCallback, useEffect, useRef, useState } from 'react'
import { ActionIcon, Alert, Anchor, Button, Collapse, Group, Stack, Text, Tooltip, UnstyledButton } from '@mantine/core'
import { IconArrowUpRight, IconUser, IconX } from '@tabler/icons-react'
import type { GapInsight, ProfileInsights } from '@shared/insights-types'
import { api, errorText } from '../../api'
import { MonoLabel, ProgressBar, SectionCard, StatusPill } from '../../components/ui'
import { useNavigation, type ProfileSection } from '../../navigation'
import classes from './dashboard.module.css'
import { EvidenceModal } from './EvidenceModal'

/** Fired after the master profile is saved from the dashboard, so the skills card refreshes too. */
export const PROFILE_SAVED_EVENT = 'huntgry:profile-saved'

const SECTION_LABEL: Record<ProfileSection, string> = {
  contact: 'Contact',
  summary: 'Summary & skills',
  experience: 'Experience',
  projects: 'Projects',
  education: 'Education',
  credentials: 'Certifications',
  notes: 'Gaps & notes',
  application: 'Application details'
}

const TOP = 5

function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 60) return `${days} days ago`
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

/**
 * The master profile's side of the dashboard: when it was last updated, what
 * is empty, and the skills job descriptions keep asking for that it lacks,
 * each with "I have this" (add evidence) or "Not me" (dismiss).
 */
export function ProfileInsightsCard() {
  const { navigate } = useNavigation()
  const [data, setData] = useState<ProfileInsights | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [all, setAll] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)
  const [editing, setEditing] = useState<GapInsight | null>(null)

  // Loads, dismissals and restores all return the full insights; only the latest request's result applies,
  // so a slow focus reload cannot bring back a gap that was just dismissed.
  const latest = useRef(0)
  const apply = useCallback((request: Promise<ProfileInsights>) => {
    const mine = ++latest.current
    request
      .then((d) => {
        if (latest.current !== mine) return
        setData(d)
        setError(null)
      })
      .catch((e) => latest.current === mine && setError(errorText(e)))
  }, [])
  const load = useCallback(() => apply(api.insights.get()), [apply])

  useEffect(() => {
    load()
    const off = api.on('applications:changed', load)
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [load])

  if (error && !data) {
    return (
      <SectionCard title="Master profile" titleOrder={4} icon={<IconUser size={18} />} padding="md">
        <Text size="sm" c="red">
          {error}
        </Text>
      </SectionCard>
    )
  }
  if (!data) return null

  const gaps = all ? data.gaps : data.gaps.slice(0, TOP)
  return (
    <SectionCard
      title="Master profile"
      titleOrder={4}
      icon={<IconUser size={18} />}
      description={
        <>
          {data.profile.updatedAt ? `Updated ${ago(data.profile.updatedAt)}` : 'Not saved yet'}
          {data.jobCount > 0 && ` · compared with ${data.jobCount} job description${data.jobCount === 1 ? '' : 's'}`}
        </>
      }
      actions={
        <Button size="xs" variant="subtle" rightSection={<IconArrowUpRight size={14} />} onClick={() => navigate('profile')}>
          Open
        </Button>
      }
      padding="md"
    >
      <Stack gap="sm">
        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
            Could not refresh: {error}
          </Alert>
        )}

        {data.profile.emptySections.length > 0 && (
          <Group gap={6}>
            <Text size="xs" c="dimmed">
              Empty:
            </Text>
            {data.profile.emptySections.map((s) => (
              <UnstyledButton key={s} onClick={() => navigate('profile', { section: s })} style={{ display: 'inline-flex' }}>
                <StatusPill tone="warning">{SECTION_LABEL[s]}</StatusPill>
              </UnstyledButton>
            ))}
          </Group>
        )}

        <MonoLabel component="div">Asked for by jobs, missing from your profile</MonoLabel>
        {data.gaps.length === 0 ? (
          <Text size="sm" c="dimmed">
            {data.jobCount === 0
              ? 'Save jobs or tailor a resume, and the skills they ask for that your profile lacks show up here.'
              : 'Nothing: your profile covers what these jobs ask for.'}
          </Text>
        ) : (
          <Stack gap="sm">
            {gaps.map((g) => (
              <div key={g.key} className={classes.gapRow}>
                <div className={classes.gapLine}>
                  <p className={classes.gapSkill}>{g.skill}</p>
                  <Tooltip label={g.jobs.map((j) => j.title).join(' · ')} multiline maw={420} withinPortal>
                    <span>
                      <MonoLabel>
                        {g.jobs.length} job{g.jobs.length === 1 ? '' : 's'}
                      </MonoLabel>
                    </span>
                  </Tooltip>
                  <Button size="xs" variant="light" color="trail" onClick={() => setEditing(g)}>
                    I have this
                  </Button>
                  <Tooltip label="Not me: hide this skill">
                    <ActionIcon size="sm" variant="subtle" color="gray" aria-label="Not me" onClick={() => apply(api.insights.dismiss(g.key, g.skill))}>
                      <IconX size={14} />
                    </ActionIcon>
                  </Tooltip>
                </div>
                <ProgressBar
                  size="xs"
                  value={data.jobCount > 0 ? Math.min(100, (g.jobs.length / data.jobCount) * 100) : 0}
                  aria-label={`${g.skill}: asked for by ${g.jobs.length} of ${data.jobCount} jobs`}
                />
              </div>
            ))}
          </Stack>
        )}

        {(data.gaps.length > TOP || data.dismissed.length > 0) && (
          <Group gap={6}>
            {data.gaps.length > TOP && (
              <Anchor size="xs" component="button" onClick={() => setAll(!all)}>
                {all ? 'Show fewer' : `Show all ${data.gaps.length}`}
              </Anchor>
            )}
            {data.gaps.length > TOP && data.dismissed.length > 0 && (
              <Text size="xs" c="dimmed" aria-hidden>
                ·
              </Text>
            )}
            {data.dismissed.length > 0 && (
              <Anchor size="xs" component="button" onClick={() => setShowDismissed(!showDismissed)} ta="left">
                {showDismissed ? 'Hide' : 'Show'} {data.dismissed.length} marked “not me”
              </Anchor>
            )}
          </Group>
        )}
        {data.dismissed.length > 0 && (
          <Collapse expanded={showDismissed}>
            <Group gap={6}>
              {data.dismissed.map((d) => (
                <StatusPill key={d.key} variant="outline" title={`Marked “not me” ${ago(d.at)}`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span>{d.skill}</span>
                    <Anchor size="xs" component="button" onClick={() => apply(api.insights.restore(d.key))}>
                      restore
                    </Anchor>
                  </span>
                </StatusPill>
              ))}
            </Group>
          </Collapse>
        )}
        {data.noted.length > 0 && (
          <Text size="xs" c="dimmed">
            Already in your Gaps &amp; notes: {data.noted.join(', ')}
          </Text>
        )}
      </Stack>

      <EvidenceModal
        gap={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          load()
          window.dispatchEvent(new Event(PROFILE_SAVED_EVENT))
        }}
      />
    </SectionCard>
  )
}
