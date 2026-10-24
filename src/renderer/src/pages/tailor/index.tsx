import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Loader } from '@mantine/core'
import { IconListCheck, IconSettings } from '@tabler/icons-react'
import type { TailorJobInput } from '@shared/queue-types'
import type { RunDetail, RunnerEnvironment, RunSummary } from '@shared/runner-types'
import { appendLive } from '@shared/transcript'
import { api, errorText } from '../../api'
import { usePipeline } from '../../components/queue/usePipeline'
import { useQueue } from '../../components/queue/useQueue'
import { PageHeader } from '../../components/ui'
import { useNavigation, type PageParams } from '../../navigation'
import { PipelinePanel } from './PipelinePanel'
import { QueuePanel } from './QueuePanel'
import { RunList } from './RunList'
import { RunView } from './RunView'
import { StartForm } from './StartForm'
import classes from './tailor.module.css'

/** Runs the Claude resume-tailor skill against the workspace, for one job or a queue of jobs. */
export function TailorPage({ params }: { params: PageParams['tailor'] }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  // Opening the page with a job (from the Jobs page) shows the form pre-filled.
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [environment, setEnvironment] = useState<RunnerEnvironment | null>(null)
  const [starting, setStarting] = useState(false)
  /** The queue item a Start made: its run opens here once the queue starts it. */
  const [pendingItem, setPendingItem] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [queue, setQueue] = useQueue()
  const [pipeline, setPipeline] = usePipeline()
  const { navigate } = useNavigation()
  const review = (applicationId: string) => navigate('review', applicationId ? { applicationId } : undefined)
  // While a pipeline exists its jobs show in its panel; the queue panel keeps the rest.
  const pipelineItems = queue && pipeline ? queue.items.filter((i) => i.pipelineId === pipeline.id) : []
  const otherItems = queue && pipeline ? queue.items.filter((i) => i.pipelineId !== pipeline.id) : (queue?.items ?? [])
  /** Run whose events are being read from disk, with the live events that arrived meanwhile. */
  const loading = useRef<{ id: string; buffer: { seq: number; event: unknown }[] } | null>(null)
  const runsById = useMemo(() => new Map(runs.map((r) => [r.id, r])), [runs])
  // "Queue" in the header (or Tailor all on the Jobs page) shows the queue panel even when it is empty.
  const [showQueue, setShowQueue] = useState(params?.view === 'queue')
  useEffect(() => {
    if (params?.view === 'queue') setShowQueue(true)
  }, [params?.view])
  const panels = useRef<HTMLDivElement>(null)
  const activeInQueue = queue?.items.filter((i) => ['queued', 'preparing', 'running', 'needs-reply'].includes(i.status)).length ?? 0

  useEffect(() => {
    api.runner.listRuns().then(setRuns, (err) => setError(errorText(err)))
    api.runner.environment().then(setEnvironment, () => setEnvironment(null))
  }, [])

  // Live updates: summaries for the list, events for the open run.
  useEffect(() => {
    const offRun = api.on('runner:run', (run) => {
      setRuns((rs) =>
        [run, ...rs.filter((r) => r.id !== run.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      )
      setDetail((d) => (d && d.run.id === run.id ? { ...d, run } : d))
    })
    const offEvent = api.on('runner:event', ({ runId, seq, event }) => {
      // The run is still loading from disk: keep its events until the file has been read.
      if (loading.current?.id === runId) {
        loading.current.buffer.push({ seq, event })
        return
      }
      setDetail((d) => (d && d.run.id === runId ? { ...d, events: appendLive(d.events, seq, event) } : d))
    })
    return () => {
      offRun()
      offEvent()
    }
  }, [])

  const open = useCallback(async (id: string | null) => {
    setSelected(id)
    setError(null)
    if (id === null) return setDetail(null)
    const pending = { id, buffer: [] as { seq: number; event: unknown }[] }
    loading.current = pending
    try {
      const loaded = await api.runner.getRun(id)
      // Merge what streamed in while the file was read; appendLive drops what the file already had.
      let events = loaded.events
      for (const { seq, event } of pending.buffer.sort((a, b) => a.seq - b.seq)) events = appendLive(events, seq, event)
      if (loading.current === pending) setDetail({ ...loaded, events })
    } catch (err) {
      setError(errorText(err))
    } finally {
      if (loading.current === pending) loading.current = null
    }
  }, [])

  // Opened on one run (the Dashboard links to the runs behind its figures).
  useEffect(() => {
    if (params?.runId) void open(params.runId)
  }, [params?.runId, open])

  // One flow (#158): Start saves the job and queues it like any other; its run opens once it starts.
  async function start(p: TailorJobInput) {
    setStarting(true)
    setError(null)
    try {
      const res = await api.queue.tailor(p)
      setQueue(res.state)
      setShowQueue(true)
      setPendingItem(res.itemId)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setStarting(false)
    }
  }

  useEffect(() => {
    if (!pendingItem || !queue) return
    const item = queue.items.find((i) => i.id === pendingItem)
    if (!item || item.status === 'cancelled') return setPendingItem(null)
    if (item.runId) {
      setPendingItem(null)
      void open(item.runId)
    } else if (item.status === 'failed') {
      setPendingItem(null)
      setError(item.error ?? 'The job could not start.')
    }
  }, [queue, pendingItem, open])

  const queueVisible = !!queue && ((showQueue && !pipeline) || otherItems.length > 0)

  return (
    <div className={classes.page}>
      <PageHeader
        eyebrow={`The kitchen · ${runs.length} run${runs.length === 1 ? '' : 's'} in this workspace`}
        title="Tailor"
        subtitle={
          selected === null
            ? 'Run the resume-tailor skill with Claude, Codex or Antigravity. Every run goes to the end; you check the result on the Review page.'
            : undefined
        }
        actions={
          <>
            {queue && (
              <Button
                variant="default"
                leftSection={<IconListCheck size={16} />}
                onClick={() => {
                  setShowQueue(true)
                  // After the panel has rendered.
                  setTimeout(() => panels.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }), 0)
                }}
              >
                Queue · {activeInQueue}
              </Button>
            )}
            <Button variant="subtle" leftSection={<IconSettings size={16} />} onClick={() => navigate('settings')}>
              Settings
            </Button>
          </>
        }
      />
      {error && (
        <Alert color="danger" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {pendingItem && (
        <Alert color="trail" title="Saved to Jobs and queued">
          The run opens here as soon as the queue starts it (it waits for a free slot while other jobs run).
        </Alert>
      )}
      {((queue && pipeline) || queueVisible) && (
        <div ref={panels} className={classes.page}>
          {queue && pipeline && (
            <PipelinePanel
              state={pipeline}
              queue={{ ...queue, items: pipelineItems }}
              onQueueChange={setQueue}
              onPipelineChange={setPipeline}
              onOpenRun={(id) => void open(id)}
              onReview={review}
              runs={runsById}
            />
          )}
          {queue && queueVisible && (
            <QueuePanel
              queue={{ ...queue, items: otherItems }}
              onChange={setQueue}
              onOpenRun={(id) => void open(id)}
              onReview={review}
              runs={runsById}
            />
          )}
        </div>
      )}
      <div className={classes.split}>
        <RunList runs={runs} selected={selected} onSelect={open} />
        <div className={classes.main}>
          {selected === null ? (
            <StartForm
              key={JSON.stringify(params ?? {})}
              prefill={params}
              environment={environment}
              busy={starting}
              onStart={start}
              onEnvironmentChange={setEnvironment}
              runs={runs}
            />
          ) : detail && detail.run.id === selected ? (
            <RunView
              run={detail.run}
              events={detail.events}
              heldReply={queue?.items.some((i) => i.runId === detail.run.id && i.pendingReply) ?? false}
            />
          ) : (
            <Loader />
          )}
        </div>
      </div>
    </div>
  )
}
