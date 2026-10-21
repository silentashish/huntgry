import { useEffect, useMemo, useState } from 'react'
import { Alert, Button, Loader, SegmentedControl, TextInput } from '@mantine/core'
import { IconCheck, IconCompass, IconPlus, IconRefresh, IconSearch } from '@tabler/icons-react'
import { WORK_MODELS, type ExploreJob, type ExploreList } from '@shared/explore-types'
import type { Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { CompanyAvatar, EmptyState, MonoLabel, PageHeader, StatusPill } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { addedJobs, dayGroups, dayLabel, defaultDay, updatedAgo, visibleRows, type WorkModelFilter } from './view'
import classes from './explore.module.css'

const WORK_TONE = { Remote: 'trail', Hybrid: 'neutral', 'On Site': 'neutral' } as const

/**
 * Explore (#142): Jobright's daily new-grad list from its public GitHub README, grouped by posted day
 * (today first), cached in the workspace. Any row can be added to the Jobs page in one click.
 */
export function ExplorePage() {
  const { navigate } = useNavigation()
  const [list, setList] = useState<ExploreList | null>(null)
  const [saved, setSaved] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pickedDay, setDay] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [workModel, setWorkModel] = useState<WorkModelFilter>('all')
  const [adding, setAdding] = useState<Set<string>>(new Set())
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    api.explore
      .list()
      .then(setList, (err) => setError(errorText(err)))
      .finally(() => setLoading(false))
    api.jobs.list().then(setSaved, () => undefined)
    // "Updated … ago" stays true while the page is open.
    const tick = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(tick)
  }, [])

  async function refresh() {
    setRefreshing(true)
    setError(null)
    try {
      setList(await api.explore.refresh())
      setNow(Date.now())
    } catch (err) {
      // The cached list stays on screen; the error says why it could not be refreshed.
      setError(errorText(err))
    } finally {
      setRefreshing(false)
    }
  }

  async function add(row: ExploreJob) {
    setAdding((s) => new Set(s).add(row.id))
    setError(null)
    try {
      const job = await api.explore.add(row.id)
      setSaved((cur) => [...cur.filter((j) => j.id !== job.id), job])
    } catch (err) {
      setError(errorText(err))
    } finally {
      setAdding((s) => {
        const next = new Set(s)
        next.delete(row.id)
        return next
      })
    }
  }

  const jobs = list?.jobs ?? []
  const groups = useMemo(() => dayGroups(jobs), [jobs])
  const day = pickedDay && groups.some((g) => g.day === pickedDay) ? pickedDay : defaultDay(groups, new Date(now))
  const rows = useMemo(() => visibleRows(jobs, { day, text, workModel }), [jobs, day, text, workModel])
  const added = useMemo(() => addedJobs(saved), [saved])
  const nowDate = new Date(now)

  return (
    <div className={classes.page}>
      <PageHeader
        eyebrow={`Jobright new-grad list · ${jobs.length} jobs`}
        title="Explore"
        subtitle="Daily new-grad software jobs from Jobright's public GitHub list. Add any of them to Jobs."
        actions={
          <>
            <MonoLabel size="sm" tone="muted">
              {list ? updatedAgo(list.fetchedAt, now) : ''}
            </MonoLabel>
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          </>
        }
      />

      {error && (
        <Alert color="danger" variant="light" title="The Jobright list could not be loaded" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {loading ? (
        <Loader aria-label="Loading the Jobright list" />
      ) : jobs.length === 0 ? (
        <EmptyState
          className={classes.empty}
          compact
          icon={<IconCompass size={22} />}
          title="No jobs to explore yet"
          description="Huntgry reads Jobright's new-grad list from GitHub. Refresh to try again."
          actions={
            <Button variant="default" leftSection={<IconRefresh size={16} />} loading={refreshing} onClick={() => void refresh()}>
              Refresh
            </Button>
          }
        />
      ) : (
        <>
          <div className={classes.days} role="group" aria-label="Posted day">
            {groups.map((g) => (
              <button
                key={g.day}
                type="button"
                className={classes.day}
                aria-pressed={g.day === day}
                onClick={() => setDay(g.day)}
              >
                <span>{dayLabel(g.day, nowDate)}</span>
                <span className={classes.dayCount}>{g.count}</span>
              </button>
            ))}
          </div>
          <div className={classes.row}>
            <TextInput
              className={classes.grow}
              leftSection={<IconSearch size={16} />}
              placeholder="Filter by company, title or location"
              aria-label="Filter Jobright jobs"
              value={text}
              onChange={(e) => setText(e.currentTarget.value)}
            />
            <SegmentedControl
              aria-label="Work model"
              value={workModel}
              onChange={(v) => setWorkModel(v as WorkModelFilter)}
              data={[{ value: 'all', label: 'Any' }, ...WORK_MODELS.map((w) => ({ value: w, label: w }))]}
            />
          </div>
          <MonoLabel component="div">
            {rows.length} of {groups.find((g) => g.day === day)?.count ?? 0} jobs · {day ? dayLabel(day, nowDate) : ''}
          </MonoLabel>
          {rows.length === 0 ? (
            <p className={classes.note}>No job of this day matches the filters.</p>
          ) : (
            <ul className={classes.list} aria-label="Jobright jobs">
              {rows.map((r) => {
                const savedJob = added.get(r.id)
                return (
                  <li key={r.id} className={classes.job} aria-label={`${r.title} at ${r.company}`}>
                    <CompanyAvatar name={r.company} />
                    <div className={classes.body}>
                      <button
                        type="button"
                        className={classes.title}
                        title="Open the posting in the browser"
                        onClick={() => navigate('browser', { url: r.url })}
                      >
                        {r.title}
                      </button>
                      <p className={classes.meta}>{[r.company, r.location].filter(Boolean).join(' · ')}</p>
                    </div>
                    <div className={classes.side}>
                      {r.workModel && <StatusPill tone={WORK_TONE[r.workModel]}>{r.workModel}</StatusPill>}
                      {savedJob ? (
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconCheck size={14} />}
                          title="Open it on the Jobs page"
                          onClick={() => navigate('jobs', { reload: Date.now(), openId: savedJob.id })}
                        >
                          Added
                        </Button>
                      ) : (
                        <Button
                          size="xs"
                          variant="secondary"
                          leftSection={<IconPlus size={14} />}
                          loading={adding.has(r.id)}
                          onClick={() => void add(r)}
                        >
                          Add to Jobs
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </>
      )}
    </div>
  )
}
