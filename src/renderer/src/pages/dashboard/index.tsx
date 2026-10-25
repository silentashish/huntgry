import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Center, Loader, VisuallyHidden } from '@mantine/core'
import { IconRefresh, IconSparkles } from '@tabler/icons-react'
import type { ApplicationsList, ApplicationStatus } from '@shared/applications-types'
import { isProfileEmpty } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { KpiTile, PageHeader } from '../../components/ui'
import { useNavigation } from '../../navigation'
import classes from './dashboard.module.css'
import { FirstHunt } from './FirstHunt'
import { LastPipelineCard } from './LastPipelineCard'
import { NeedsYouStrip, needsYouCount, useNeedsYou } from './NeedsYou'
import { PROFILE_SAVED_EVENT, ProfileInsightsCard } from './ProfileInsightsCard'
import { StrongestEvidenceCard } from './StrongestEvidenceCard'
import { UsageCard } from './UsageCard'
import { STATUS_META } from './status'
import { applyLocation, countByStatus, eyebrowDate, greetingLine, kpiColumn, kpiSubs, needsYouLine, readyToApply, type KpiKey } from './summary'

const SUMMARY: Exclude<ApplicationStatus, 'archived'>[] = ['generated', 'applied', 'interviewing', 'offer', 'rejected']

/** The master profile's name and whether it has content, re-read after a save and on focus. */
function useProfileGlance(): { name: string | null; ready: boolean | null } {
  const [glance, setGlance] = useState<{ name: string | null; ready: boolean | null }>({ name: null, ready: null })
  useEffect(() => {
    let alive = true
    const load = () =>
      void api.profile.read().then(
        (doc) => alive && setGlance({ name: doc.profile.contact.name, ready: !isProfileEmpty(doc.profile) }),
        () => alive && setGlance({ name: null, ready: false })
      )
    load()
    window.addEventListener(PROFILE_SAVED_EVENT, load)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.removeEventListener(PROFILE_SAVED_EVENT, load)
      window.removeEventListener('focus', load)
    }
  }, [])
  return glance
}

/** Re-renders when the hour changes, so the greeting follows the clock. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(t)
  }, [])
  return now
}

/**
 * The summary of the hunt (#109): what needs the user, the applications by status, the last
 * pipeline, the profile insights and usage. Applications themselves are browsed on the Board
 * (#161): the stat tiles and "Ready to apply" open it.
 */
export function DashboardPage() {
  const { navigate } = useNavigation()
  const [list, setList] = useState<ApplicationsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const needs = useNeedsYou()
  const profile = useProfileGlance()
  const now = useNow()

  // Mount, focus and file-watch events can overlap; only the latest list call may update the page.
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    try {
      const next = await api.applications.list()
      if (latestLoad.current !== request) return
      setList(next)
      setError(null)
    } catch (err) {
      // A newer load has superseded this request: its error is stale too.
      if (latestLoad.current === request) setError(errorText(err))
    }
  }, [])

  // Initial load, then re-list when the workspace changes on disk or the window regains focus.
  useEffect(() => {
    void load()
    const off = api.on('applications:changed', () => void load())
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const apps = useMemo(() => list?.applications ?? [], [list])
  const counts = useMemo(() => countByStatus(apps), [apps])
  const subs = useMemo(() => kpiSubs(apps, now), [apps, now])
  const ready = useMemo(() => readyToApply(apps), [apps])
  const empty = list !== null && apps.length === 0
  const things = needsYouCount(needs, ready)

  function refresh() {
    void load()
    needs.reload()
  }

  /** "Apply" in the strip: one result opens its drawer on the Board; several, the Board's Ready to apply. */
  const goApply = () => navigate('board', applyLocation(ready))

  // A tile opens the Board on its column (Total: the whole Board, this week's cards open).
  const tile = (key: KpiKey, label: string, value: number) => (
    <KpiTile
      key={key}
      label={label}
      value={<span data-testid="stat-value">{value}</span>}
      sub={subs[key]}
      aria-label={`${label}: ${value}${subs[key] ? `, ${subs[key]}` : ''}. Open on the Board`}
      onClick={() => navigate('board', kpiColumn(key) ? { column: kpiColumn(key) } : undefined)}
    />
  )

  return (
    <div className={classes.page}>
      <PageHeader
        eyebrow={`${eyebrowDate(now)} · ${empty ? 'nothing tracked yet' : 'the hound is awake'}`}
        title={
          <>
            <VisuallyHidden>Dashboard: </VisuallyHidden>
            {empty ? 'Welcome to the den.' : greetingLine(now, profile.name)}
          </>
        }
        subtitle={empty && things === 0 ? 'Three steps and the hound starts running.' : list || error ? needsYouLine(things) : undefined}
        actions={
          <>
            <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={refresh}>
              Refresh
            </Button>
            <Button variant="primary" leftSection={<IconSparkles size={16} />} onClick={() => navigate('tailor')}>
              New tailored resume
            </Button>
          </>
        }
      />

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {list === null && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {/* No applications (a first hunt, or a pipeline whose every job failed) or no list at all: what
          needs the user, the last pipeline and the profile insights still show. */}
      {(empty || (list === null && error)) && (
        <>
          <NeedsYouStrip
            waiting={needs.waiting}
            review={needs.review}
            ready={[]}
            onReply={(run) => navigate('tailor', { runId: run.id })}
            onReview={() => navigate('review')}
            onApply={goApply}
          />
          {empty && <FirstHunt profileReady={profile.ready} />}
          <div className={classes.sideRow} aria-label="Pipeline and profile" role="complementary">
            <LastPipelineCard />
            <ProfileInsightsCard />
          </div>
          <UsageCard onOpenRun={(runId) => navigate('tailor', { runId })} hideWhenEmpty />
        </>
      )}

      {list && apps.length > 0 && (
        <>
          <NeedsYouStrip
            waiting={needs.waiting}
            review={needs.review}
            ready={ready}
            onReply={(run) => navigate('tailor', { runId: run.id })}
            onReview={() => navigate('review')}
            onApply={goApply}
          />

          <div className={classes.kpis} role="group" aria-label="Applications by status">
            {tile('total', 'Total', apps.length)}
            {SUMMARY.map((s) => tile(s, STATUS_META[s].label, counts[s]))}
          </div>

          {list.truncated && (
            <Alert color="yellow" variant="light">
              The workspace is large; the scan stopped early and some applications may be missing.
            </Alert>
          )}

          <div className={classes.sideRow} aria-label="Pipeline and profile" role="complementary">
            <LastPipelineCard />
            <ProfileInsightsCard />
            <StrongestEvidenceCard />
          </div>

          <UsageCard onOpenRun={(runId) => navigate('tailor', { runId })} />
        </>
      )}

    </div>
  )
}
