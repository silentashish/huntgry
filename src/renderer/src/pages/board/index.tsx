import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Anchor, Badge, Button, Center, Group, Loader, Paper, ScrollArea, Stack, Text, TextInput, Title } from '@mantine/core'
import { IconLink, IconRefresh } from '@tabler/icons-react'
import type { ApplicationRecord, ApplicationTracking } from '@shared/applications-types'
import {
  ARCHIVE_TTL_DAYS,
  buildBoard,
  moveFor,
  type BoardCard,
  type BoardColumn,
  type BoardColumnId
} from '@shared/board'
import { tailorPrefillFor, type Job } from '@shared/jobs-types'
import { api, errorText } from '../../api'
import { useApply } from '../../components/apply/useApply'
import { useQueue } from '../../components/queue/useQueue'
import { useNavigation } from '../../navigation'
import { ApplicationDrawer } from '../dashboard/ApplicationDrawer'
import { BulkTailorModal } from '../jobs/BulkTailorModal'
import { JobDrawer } from '../jobs/JobDrawer'
import { mergeJobs } from '../jobs/merge'
import { PasteModal } from '../jobs/PasteModal'
import { prepareTailor } from '../jobs/handoff'
import { BoardCardView } from './BoardCardView'

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/**
 * Every job of the workspace on one Kanban board (#85): saved jobs (To do), runs (Tailoring,
 * Waiting for review) and applications by status, one card per job. A link pasted into To do saves
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
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Board</Title>
        <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={load}>
          Refresh
        </Button>
      </Group>

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
          <Group align="flex-start" wrap="nowrap" gap="sm" pb="sm">
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
                    <Stack gap={6}>
                      <Group gap={4} wrap="nowrap">
                        <TextInput
                          size="xs"
                          style={{ flex: 1 }}
                          leftSection={<IconLink size={14} />}
                          placeholder="Paste a posting link"
                          aria-label="Paste a posting link"
                          value={url}
                          onChange={(e) => setUrl(e.currentTarget.value)}
                          onKeyDown={(e) => e.key === 'Enter' && void addUrl()}
                        />
                        <Button size="xs" onClick={addUrl} loading={adding} disabled={!isUrl(url)}>
                          Add
                        </Button>
                      </Group>
                      <Anchor size="xs" component="button" type="button" onClick={() => setPasteOpen(true)}>
                        or paste the description
                      </Anchor>
                      {addError && (
                        <Alert color="red" variant="light" p="xs" withCloseButton onClose={() => setAddError(null)}>
                          <Text size="xs">{addError}</Text>
                        </Alert>
                      )}
                    </Stack>
                  ) : column.id === 'archived' ? (
                    <Text size="xs" c="dimmed">
                      Cards leave the board {ARCHIVE_TTL_DAYS} days after they are archived.
                      {board.hiddenArchived > 0 && ` ${board.hiddenArchived} older not shown.`}
                    </Text>
                  ) : null
                }
              >
                {column.cards.map((card) => (
                  <BoardCardView
                    key={card.key}
                    card={card}
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
                  />
                ))}
              </Column>
            ))}
          </Group>
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
    <Paper
      component="section"
      aria-label={column.label}
      data-column={column.id}
      withBorder
      radius="md"
      p="xs"
      w={272}
      miw={272}
      bg="var(--mantine-color-default-hover)"
      onDragOver={(e: React.DragEvent) => {
        if (!dropTarget) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        onDragOver()
      }}
      onDragLeave={onDragLeave}
      onDrop={(e: React.DragEvent) => {
        if (!dropTarget) return
        e.preventDefault()
        onDrop()
      }}
      style={{
        opacity: dropTarget === false ? 0.45 : 1,
        borderColor: over && dropTarget ? 'var(--mantine-primary-color-filled)' : undefined,
        transition: 'opacity 120ms'
      }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Title order={4} size="sm">
            {column.label}
          </Title>
          <Badge size="sm" variant="light" color="gray" aria-label={`${column.cards.length} cards`}>
            {column.cards.length}
          </Badge>
        </Group>
        {header}
        {children}
        {column.cards.length === 0 && (
          <Text size="xs" c="dimmed" ta="center" py="sm">
            Nothing here
          </Text>
        )}
      </Stack>
    </Paper>
  )
}
