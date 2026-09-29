import { useCallback, useEffect, useState } from 'react'
import { Alert, Grid, Loader, Stack, Title } from '@mantine/core'
import type { RunDetail, RunnerEnvironment, RunSummary, StartRunParams } from '@shared/runner-types'
import { api, errorText } from '../../api'
import type { PageParams } from '../../navigation'
import { RunList } from './RunList'
import { RunView } from './RunView'
import { StartForm } from './StartForm'

/** Runs the Claude resume-tailor skill against the workspace for one job. */
export function TailorPage({ params }: { params: PageParams['tailor'] }) {
  const [runs, setRuns] = useState<RunSummary[]>([])
  // Opening the page with a job (from the Jobs page) shows the form pre-filled.
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<RunDetail | null>(null)
  const [environment, setEnvironment] = useState<RunnerEnvironment | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    const offEvent = api.on('runner:event', ({ runId, event }) => {
      setDetail((d) => (d && d.run.id === runId ? { ...d, events: [...d.events, event] } : d))
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
    try {
      setDetail(await api.runner.getRun(id))
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

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
            />
          ) : detail && detail.run.id === selected ? (
            <RunView run={detail.run} events={detail.events} />
          ) : (
            <Loader />
          )}
        </Grid.Col>
      </Grid>
    </Stack>
  )
}
