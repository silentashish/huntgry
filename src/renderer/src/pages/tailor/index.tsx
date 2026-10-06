import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Grid, Loader, Stack, Title } from '@mantine/core'
import type { RunDetail, RunnerEnvironment, RunSummary, StartRunParams } from '@shared/runner-types'
import { appendLive } from '@shared/transcript'
import { api, errorText } from '../../api'
import { usePipeline } from '../../components/queue/usePipeline'
import { useQueue } from '../../components/queue/useQueue'
import { useNavigation, type PageParams } from '../../navigation'
import { PipelinePanel } from './PipelinePanel'
import { QueuePanel } from './QueuePanel'
import { RunList } from './RunList'
import { RunView } from './RunView'
import { StartForm } from './StartForm'

/** Runs the Claude resume-tailor skill against the workspace, for one job or a queue of jobs. */
export function TailorPage({ params }: { params: PageParams['tailor'] }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  // Opening the page with a job (from the Jobs page) shows the form pre-filled.
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [environment, setEnvironment] = useState<RunnerEnvironment | null>(null)
  const [starting, setStarting] = useState(false)
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

  async function start(p: StartRunParams) {
    setStarting(true)
    setError(null)
    try {
      const run = await api.runner.start(p)
      setRuns((rs) => [run, ...rs.filter((r) => r.id !== run.id)])
      await open(run.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setStarting(false)
    }
  }

  return (
    <Stack gap="md">
      <Title order={2}>Tailor</Title>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
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
      {queue && ((params?.view === 'queue' && !pipeline) || otherItems.length > 0) && (
        <QueuePanel
          queue={{ ...queue, items: otherItems }}
          onChange={setQueue}
          onOpenRun={(id) => void open(id)}
          onReview={review}
          runs={runsById}
        />
      )}
      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 3 }}>
          <RunList runs={runs} selected={selected} onSelect={open} />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          {selected === null ? (
            <StartForm
              key={JSON.stringify(params ?? {})}
              prefill={params}
              environment={environment}
              busy={starting}
              onStart={start}
              onEnvironmentChange={setEnvironment}
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
        </Grid.Col>
      </Grid>
    </Stack>
  )
}
