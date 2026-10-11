import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Center, Loader, MultiSelect, Select, TextInput, VisuallyHidden } from '@mantine/core'
import { IconArrowsSort, IconFilter, IconRefresh, IconSearch, IconSparkles } from '@tabler/icons-react'
import {
  APPLICATION_STATUSES,
  type ApplicationRecord,
  type ApplicationsList,
  type ApplicationStatus,
  type ApplicationTracking
} from '@shared/applications-types'
import { isProfileEmpty } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useApply } from '../../components/apply/useApply'
import { KpiTile, MonoLabel, PageHeader } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { ApplicationDrawer } from './ApplicationDrawer'
import { ApplicationsTable } from './ApplicationsTable'
import classes from './dashboard.module.css'
import { FirstHunt } from './FirstHunt'
import { LastPipelineCard } from './LastPipelineCard'
import { NeedsYouStrip, needsYouCount, useNeedsYou } from './NeedsYou'
import { PROFILE_SAVED_EVENT, ProfileInsightsCard } from './ProfileInsightsCard'
import { StrongestEvidenceCard } from './StrongestEvidenceCard'
import { UsageCard } from './UsageCard'
import { countByStatus, DEFAULT_FILTER, filterApplications, type Filter, type SortKey } from './filter'
import { STATUS_META } from './status'
import { eyebrowDate, greetingLine, kpiSubs, needsYouLine, readyToApply, type KpiKey } from './summary'

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

/** Every generated resume and cover letter in the workspace, with tracking, what needs the user, and usage (#109). */
export function DashboardPage() {
  const { navigate } = useNavigation()
  const [list, setList] = useState<ApplicationsList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>(DEFAULT_FILTER)
  const [openId, setOpenId] = useState<string | null>(null)
  const applier = useApply(setError)
  const needs = useNeedsYou()
  const profile = useProfileGlance()
  const now = useNow()
  const tableRef = useRef<HTMLDivElement>(null)

  // Bumped by every successful tracking update; a list() that started before it may hold stale tracking.
  const generation = useRef(0)

  // Mount, focus and file-watch events can overlap; only the latest list call may update the page.
  const latestLoad = useRef(0)
  const load = useCallback(async () => {
    const request = ++latestLoad.current
    const started = generation.current
    try {
      const next = await api.applications.list()
      if (latestLoad.current !== request || generation.current !== started) return
      setList(next)
      setError(null)
    } catch (err) {
      // A newer load or a tracking update has superseded this request: its error is stale too.
      if (latestLoad.current !== request || generation.current !== started) return
      setError(errorText(err))
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
  const shown = useMemo(() => filterApplications(apps, filter), [apps, filter])
  const counts = useMemo(() => countByStatus(apps), [apps])
  const subs = useMemo(() => kpiSubs(apps, now), [apps, now])
  const ready = useMemo(() => filterApplications(readyToApply(apps), DEFAULT_FILTER), [apps])
  const open = apps.find((a) => a.id === openId) ?? null
  const empty = list !== null && apps.length === 0
  const things = needsYouCount(needs, ready)

  async function update(id: string, patch: Partial<ApplicationTracking>) {
    const next = await api.applications.updateTracking(id, patch)
    generation.current++
    setList((l) => l && { ...l, applications: l.applications.map((a) => (a.id === id ? next : a)) })
  }

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn()
    } catch (err) {
      setError(errorText(err))
    }
  }

  function refresh() {
    void load()
    needs.reload()
  }

  /** "Apply" in the strip: one result opens its drawer; several narrow the table to Generated. */
  function goApply() {
    if (ready.length === 1) {
      setOpenId(ready[0].id)
      return
    }
    setFilter({ ...filter, statuses: ['generated'] })
    tableRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const tile = (key: KpiKey, label: string, value: number, selected: boolean, statuses: ApplicationStatus[]) => (
    <KpiTile
      key={key}
      label={label}
      value={<span data-testid="stat-value">{value}</span>}
      sub={subs[key]}
      selected={selected}
      onClick={() => setFilter({ ...filter, statuses })}
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
        subtitle={empty ? 'Three steps and the hound starts running.' : list ? needsYouLine(things) : undefined}
        actions={
          <>
            {!empty && (
              <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={refresh}>
                Refresh
              </Button>
            )}
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

      {empty && (
        <>
          <FirstHunt profileReady={profile.ready} />
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
            {tile('total', 'Total', apps.length, filter.statuses.length === 0, [])}
            {SUMMARY.map((s) =>
              tile(s, STATUS_META[s].label, counts[s], filter.statuses.length === 1 && filter.statuses[0] === s, [s])
            )}
          </div>

          <div className={classes.columns}>
            <div className={classes.main} ref={tableRef}>
              <div className={classes.toolbar}>
                <TextInput
                  className={classes.search}
                  leftSection={<IconSearch size={16} />}
                  aria-label="Search applications"
                  placeholder="Search company, role, title, notes"
                  value={filter.text}
                  onChange={(e) => setFilter({ ...filter, text: e.currentTarget.value })}
                />
                <MultiSelect
                  w={180}
                  leftSection={<IconFilter size={16} />}
                  aria-label="Filter by status"
                  placeholder={filter.statuses.length ? undefined : 'All but archived'}
                  data={APPLICATION_STATUSES.map((s) => ({ value: s, label: STATUS_META[s].label }))}
                  value={filter.statuses}
                  onChange={(v) => setFilter({ ...filter, statuses: v as ApplicationStatus[] })}
                  clearable
                />
                <Select
                  aria-label="Sort applications"
                  w={156}
                  leftSection={<IconArrowsSort size={16} />}
                  data={[
                    { value: 'newest', label: 'Newest first' },
                    { value: 'oldest', label: 'Oldest first' },
                    { value: 'company', label: 'Company' }
                  ]}
                  value={filter.sort}
                  allowDeselect={false}
                  onChange={(v) => v && setFilter({ ...filter, sort: v as SortKey })}
                />
                <MonoLabel>
                  {shown.length === apps.length ? `${apps.length}` : `${shown.length} of ${apps.length}`} application
                  {apps.length === 1 ? '' : 's'}
                </MonoLabel>
              </div>

              {list.truncated && (
                <Alert color="yellow" variant="light">
                  The workspace is large; the scan stopped early and some applications may be missing.
                </Alert>
              )}

              <ApplicationsTable
                apps={shown}
                openId={openId}
                onOpen={setOpenId}
                onUpdate={(id, p) => act(() => update(id, p))}
                onAct={act}
                onApply={(a: ApplicationRecord) => applier.apply(a)}
                applying={applier.busy}
                onClearFilters={() => setFilter(DEFAULT_FILTER)}
              />
            </div>

            <aside className={classes.side} aria-label="Pipeline and profile">
              <LastPipelineCard />
              <ProfileInsightsCard />
              <StrongestEvidenceCard />
            </aside>
          </div>

          <UsageCard onOpenRun={(runId) => navigate('tailor', { runId })} />
        </>
      )}

      <ApplicationDrawer
        app={open}
        onClose={() => setOpenId(null)}
        onUpdate={(p) => update(open!.id, p)}
        onApply={(a) => applier.apply(a)}
        applying={applier.busy}
      />
      {applier.modal}
    </div>
  )
}
