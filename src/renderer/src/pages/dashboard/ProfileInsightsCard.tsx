import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Anchor, Badge, Button, Card, Collapse, Group, Stack, Text, Title, Tooltip } from '@mantine/core'
import type { GapInsight, ProfileInsights } from '@shared/insights-types'
import { api, errorText } from '../../api'
import { useNavigation, type ProfileSection } from '../../navigation'
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
  notes: 'Gaps & notes'
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
      <Card withBorder radius="md" padding="md">
        <Text size="sm" c="red">
          {error}
        </Text>
      </Card>
    )
  }
  if (!data) return null

  const gaps = all ? data.gaps : data.gaps.slice(0, TOP)
  return (
    <Card withBorder radius="md" padding="md">
      <Group justify="space-between" align="flex-start" mb="xs" wrap="nowrap">
        <div style={{ minWidth: 0 }}>
          <Title order={4}>Master profile</Title>
          <Text size="xs" c="dimmed">
            {data.profile.updatedAt ? `Updated ${ago(data.profile.updatedAt)}` : 'Not saved yet'}
            {data.jobCount > 0 && ` · compared with ${data.jobCount} job description${data.jobCount === 1 ? '' : 's'}`}
          </Text>
        </div>
        <Button size="xs" variant="subtle" style={{ flexShrink: 0 }} onClick={() => navigate('profile')}>
          Open
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" mb="sm" withCloseButton onClose={() => setError(null)}>
          Could not refresh: {error}
        </Alert>
      )}

      {data.profile.emptySections.length > 0 && (
        <Group gap={6} mb="sm">
          <Text size="xs" c="dimmed">
            Empty:
          </Text>
          {data.profile.emptySections.map((s) => (
            <Badge
              key={s}
              component="button"
              type="button"
              variant="light"
              color="yellow"
              style={{ cursor: 'pointer', border: 0 }}
              onClick={() => navigate('profile', { section: s })}
            >
              {SECTION_LABEL[s]}
            </Badge>
          ))}
        </Group>
      )}

      <Text size="xs" c="dimmed" tt="uppercase" fw={600} mb={4}>
        Asked for by jobs, missing from your profile
      </Text>
      {data.gaps.length === 0 ? (
        <Text size="sm" c="dimmed">
          {data.jobCount === 0
            ? 'Save jobs or tailor a resume, and the skills they ask for that your profile lacks show up here.'
            : 'Nothing: your profile covers what these jobs ask for.'}
        </Text>
      ) : (
        <Stack gap={6}>
          {gaps.map((g) => (
            <Group key={g.key} justify="space-between" wrap="nowrap">
              <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                <Text size="sm" fw={500}>
                  {g.skill}
                </Text>
                <Tooltip label={g.jobs.map((j) => j.title).join(' · ')} multiline maw={420} withinPortal>
                  <Badge variant="light" color="gray">
                    {g.jobs.length} job{g.jobs.length === 1 ? '' : 's'}
                  </Badge>
                </Tooltip>
              </Group>
              <Group gap={4} wrap="nowrap">
                <Button size="compact-xs" variant="light" onClick={() => setEditing(g)}>
                  I have this
                </Button>
                <Button size="compact-xs" variant="subtle" color="gray" onClick={() => apply(api.insights.dismiss(g.key, g.skill))}>
                  Not me
                </Button>
              </Group>
            </Group>
          ))}
          {data.gaps.length > TOP && (
            <Anchor size="xs" component="button" onClick={() => setAll(!all)}>
              {all ? 'Show fewer' : `Show all ${data.gaps.length}`}
            </Anchor>
          )}
        </Stack>
      )}

      {(data.noted.length > 0 || data.dismissed.length > 0) && (
        <Stack gap={4} mt="sm">
          {data.noted.length > 0 && (
            <Text size="xs" c="dimmed">
              Already in your Gaps &amp; notes: {data.noted.join(', ')}
            </Text>
          )}
          {data.dismissed.length > 0 && (
            <>
              <Anchor size="xs" component="button" onClick={() => setShowDismissed(!showDismissed)} ta="left">
                {showDismissed ? 'Hide' : 'Show'} {data.dismissed.length} marked “not me”
              </Anchor>
              <Collapse expanded={showDismissed}>
                <Group gap={6}>
                  {data.dismissed.map((d) => (
                    <Badge
                      key={d.key}
                      variant="outline"
                      color="gray"
                      rightSection={
                        <Anchor size="xs" component="button" onClick={() => apply(api.insights.restore(d.key))}>
                          restore
                        </Anchor>
                      }
                    >
                      {d.skill}
                    </Badge>
                  ))}
                </Group>
              </Collapse>
            </>
          )}
        </Stack>
      )}

      <EvidenceModal
        gap={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          load()
          window.dispatchEvent(new Event(PROFILE_SAVED_EVENT))
        }}
      />
    </Card>
  )
}
