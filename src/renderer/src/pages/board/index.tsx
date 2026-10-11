import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Center, Group, Loader, ScrollArea, Stack, Text, TextInput } from '@mantine/core'
import { IconLink, IconPlus, IconRefresh } from '@tabler/icons-react'
import type { ApplicationRecord, ApplicationTracking } from '@shared/applications-types'
import {
  ARCHIVE_TTL_DAYS,
  buildBoard,
  moveFor,
  type BoardCard,
  type BoardColumn,
  type BoardColumnId
} from '@shared/board'
import { profileSignals, type ProfileSignals } from '@shared/job-relevance'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { emptyProfile } from '@shared/master-profile'
import { api, errorText } from '../../api'
import { useApply } from '../../components/apply/useApply'
import { useQueue } from '../../components/queue/useQueue'
import { PageHeader, toneStyle } from '../../components/ui'
import { useNavigation } from '../../navigation'
import { ApplicationDrawer } from '../dashboard/ApplicationDrawer'
import { BulkTailorModal } from '../jobs/BulkTailorModal'
import { JobDrawer } from '../jobs/JobDrawer'
import { mergeJobs } from '../jobs/merge'
import { PasteModal } from '../jobs/PasteModal'
import { prepareTailor } from '../jobs/handoff'
import { BoardCardView } from './BoardCardView'
import { cardScent, COLUMN_TONE, type Scent } from './card'
import classes from './board.module.css'

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/**
 * Every job of the workspace on one Kanban board (#85): saved jobs (To do), runs (Tailoring,
 * Needs review) and applications by status, one card per job. A link pasted into To do saves
 * the job; cards move by drag and drop or their Move to menu; archived cards leave the board a week later.
 */
export function BoardPage() {
  const { navigate } = useNavigation()
  const [jobs, setJobs] = useState<Job[] | null>(null)
  const [apps, setApps] = useState<ApplicationRecord[] | null>(null)
  const [queue] = useQueue()
  const [error, setError] = useState<string | null>(null)
  const [url, setUrl] = useState('')
  const [adding, setAdding] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [dragging, setDragging] = useState<BoardCard | null>(null)
  const [over, setOver] = useState<BoardColumnId | null>(null)
  const [openJobId, setOpenJobId] = useState<string | null>(null)
  const [openAppId, setOpenAppId] = useState<string | null>(null)
  const [tailorJob, setTailorJob] = useState<Job | null>(null)
  const applier = useApply(setError)
  /** What the master profile says to score jobs on (the Scent ring); `null` until read. */
  const [signals, setSignals] = useState<ProfileSignals | null>(null)

  useEffect(() => {
    api.profile.read().then(
      (doc) => setSignals(profileSignals(doc.profile)),
      () => setSignals(profileSignals(emptyProfile()))
    )
  }, [])

  // Mount, focus and watch events can overlap; only the latest load may update the page.
  const latest = useRef(0)
  const load = useCallback(async () => {
    const request = ++latest.current
    try {
      const [nextJobs, nextApps] = await Promise.all([api.jobs.list(), api.applications.list()])
      if (latest.current !== request) return
      setJobs(nextJobs)
      setApps(nextApps.applications)
      setError(null)
    } catch (err) {
      if (latest.current === request) setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const off = api.on('applications:changed', () => void load())
    // A run that finishes or fails changes which card a job shows; the queue itself comes from useQueue.
    const offQueue = api.on('queue:changed', () => void load())
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      offQueue()
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  const board = useMemo(
    () => (jobs && apps ? buildBoard({ jobs, applications: apps, queue: queue?.items ?? [] }) : null),
    [jobs, apps, queue]
  )
  // Scored once per board, not on every drag-state render.
  const scents = useMemo(() => {
    const now = new Date()
    return new Map<string, Scent>(board?.columns.flatMap((c) => c.cards.map((card) => [card.key, cardScent(card, signals, now)] as const)) ?? [])
  }, [board, signals])
  // The tailor modal re-plans whenever its job list changes: keep the array stable.
  const tailorJobs = useMemo(() => (tailorJob ? [tailorJob] : []), [tailorJob])
  const upsert = (list: Job[]) => setJobs((cur) => mergeJobs(cur ?? [], list))

  async function addUrl() {
    if (!isUrl(url) || adding) return
    setAdding(true)
    setAddError(null)
    try {
      upsert([await api.jobs.addByUrl(url.trim())])
      setUrl('')
    } catch (err) {
      setAddError(errorText(err))
    } finally {
      setAdding(false)
    }
  }

  async function move(card: BoardCard, to: BoardColumnId) {
    const m = moveFor(card, to)
    if (!m) return
    try {
      if (m.kind === 'job') upsert([await api.jobs.update(m.id, m.patch)])
      else {
        const next = await api.applications.updateTracking(m.id, m.patch)
        setApps((cur) => cur && cur.map((a) => (a.id === next.id ? next : a)))
      }
    } catch (err) {
      setError(errorText(err))
    }
  }

  function open(card: BoardCard) {
    if (card.kind === 'job') setOpenJobId(card.job.id)
    else if (card.kind === 'application') setOpenAppId(card.app.id)
    else follow(card)
  }

  function follow(card: BoardCard) {
    if (card.kind === 'queue') navigate('tailor', card.item.runId ? { runId: card.item.runId } : { view: 'queue' })
    else if (card.kind === 'application') navigate('review', { applicationId: card.app.id })
  }

  async function updateApp(id: string, patch: Partial<ApplicationTracking>) {
    const next = await api.applications.updateTracking(id, patch)
    setApps((cur) => cur && cur.map((a) => (a.id === id ? next : a)))
  }

  const openJob = (jobs ?? []).find((j) => j.id === openJobId) ?? null
  const openApp = (apps ?? []).find((a) => a.id === openAppId) ?? null

  return (
    <Stack gap="lg">
      <PageHeader
        eyebrow="Every job, from sniffed to signed"
        title="Board"
        subtitle={`Drag a card or use Move to. Archived cards leave after ${ARCHIVE_TTL_DAYS} days; nothing is deleted.`}
        actions={
          <>
            <Button variant="subtle" leftSection={<IconRefresh size={16} />} onClick={load}>
              Refresh
            </Button>
            <Button variant="primary" leftSection={<IconPlus size={16} />} onClick={() => setPasteOpen(true)}>
              Paste a job
            </Button>
          </>
        }
      />

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!board && !error && (
        <Center py="xl">
          <Loader />
        </Center>
      )}

      {board && (
        <ScrollArea type="auto" offsetScrollbars>
          <div className={classes.lanes}>
            {board.columns.map((column) => (
              <Column
                key={column.id}
                column={column}
                dropTarget={dragging ? moveFor(dragging, column.id) !== null : null}
                over={over === column.id}
                onDragOver={() => setOver(column.id)}
                onDragLeave={() => setOver((o) => (o === column.id ? null : o))}
                onDrop={() => {
                  if (dragging) void move(dragging, column.id)
                  setDragging(null)
                  setOver(null)
                }}
                header={
                  column.id === 'todo' ? (
                    <Stack gap={10}>
                      <Group gap={6} wrap="nowrap" align="center">
                        <TextInput
                          style={{ flex: 1 }}
                          leftSection={<IconLink size={16} />}
                          placeholder="Paste a posting link"
                          aria-label="Paste a posting link"
                          value={url}
                          onChange={(e) => setUrl(e.currentTarget.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void addUrl()}
                        />
                        <Button size="xs" variant="secondary" onClick={addUrl} loading={adding} disabled={!isUrl(url)}>
                          Add
                        </Button>
                      </Group>
                      <button type="button" className={classes.pasteLink} onClick={() => setPasteOpen(true)}>
                        or paste the description
                      </button>
                      {addError && (
                        <Alert color="red" variant="light" p="xs" withCloseButton onClose={() => setAddError(null)}>
                          <Text size="xs">{addError}</Text>
                        </Alert>
                      )}
                    </Stack>
                  ) : column.id === 'archived' ? (
                    <div className={classes.laneNote}>
                      Cards leave the board {ARCHIVE_TTL_DAYS} days after they are archived.
                      {board.hiddenArchived > 0 && ` ${board.hiddenArchived} older not shown.`}
                    </div>
                  ) : null
                }
              >
                {column.cards.map((card, i) => (
                  <BoardCardView
                    key={card.key}
                    card={card}
                    scent={scents.get(card.key) ?? { mode: 'initial', letter: '?' }}
                    lead={column.id === 'todo' && i === 0}
                    dragging={dragging?.key === card.key}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => {
                      setDragging(null)
                      setOver(null)
                    }}
                    onOpen={() => open(card)}
                    onMove={(to) => void move(card, to)}
                    onTailor={() => card.kind === 'job' && setTailorJob(card.job)}
                    onFollow={() => follow(card)}
                    onApply={() => card.kind === 'application' && applier.apply(card.app)}
                  />
                ))}
              </Column>
            ))}
          </div>
        </ScrollArea>
      )}

      <JobDrawer
        job={openJob}
        onClose={() => setOpenJobId(null)}
        onChange={(j) => upsert([j])}
        onTailor={async (job) => navigate('tailor', tailorPrefillFor(await prepareTailor(job, (j) => upsert([j]))))}
      />
      <ApplicationDrawer
        app={openApp}
        onClose={() => setOpenAppId(null)}
        onUpdate={(p) => updateApp(openApp!.id, p)}
        onApply={(a) => applier.apply(a)}
        applying={applier.busy}
      />
      <BulkTailorModal
        jobs={tailorJobs}
        opened={tailorJob !== null}
        onClose={() => setTailorJob(null)}
        onQueued={(res) => {
          setTailorJob(null)
          if (res.added === 0) setError(`Nothing was queued: ${[...new Set(res.skipped.map((s) => s.reason))].join(' ')}`)
        }}
        onStarted={() => setTailorJob(null)}
      />
      <PasteModal
        opened={pasteOpen}
        onClose={() => setPasteOpen(false)}
        onSaved={(j) => {
          upsert([j])
          setPasteOpen(false)
        }}
      />
      {applier.modal}
    </Stack>
  )
}

interface ColumnProps {
  column: BoardColumn
  header: React.ReactNode
  /** While a card is dragged: whether this column takes it; `null` when nothing is dragged. */
  dropTarget: boolean | null
  over: boolean
  onDragOver(): void
  onDragLeave(): void
  onDrop(): void
  children: React.ReactNode
}

function Column({ column, header, dropTarget, over, onDragOver, onDragLeave, onDrop, children }: ColumnProps) {
  return (
    <section
      aria-label={column.label}
      className={classes.lane}
      data-drop={dropTarget === null ? undefined : String(dropTarget)}
      data-over={over && dropTarget ? 'true' : undefined}
      onDragOver={(e) => {
        if (!dropTarget) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOver()
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        if (!dropTarget) return
        e.preventDefault()
        onDrop()
      }}
    >
      <div className={classes.laneHead}>
        <span className={classes.laneDot} style={toneStyle(COLUMN_TONE[column.id])} aria-hidden />
        <h3 className={classes.laneTitle}>
          {column.label}
        </h3>
        <span className={classes.laneCount} aria-label={`${column.cards.length} cards`}>
          {column.cards.length}
        </span>
      </div>
      {header}
      {children}
      {column.cards.length === 0 && <div className={classes.laneEmpty}>Nothing here</div>}
    </section>
  )
}
