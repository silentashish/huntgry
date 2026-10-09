/**
 * The start sheet (#41): the selected saved jobs, the agent and an optional fallback (enum),
 * how many run at once (1–4) and an optional budget, mapped onto `PipelineStartInput`. The
 * desktop runs the same pre-flight as "Run unattended" and answers with its own refusal when
 * something blocks it. There is no field for a model, a flag, a path or a prompt.
 */

import { REMOTE_AGENT_IDS, REMOTE_MAX_CONCURRENCY, type RemoteAgentId } from '@huntgry/remote-protocol'
import { useEffect, useState } from 'react'
import { View } from 'react-native'
import { DEFAULT_CONCURRENCY, pipelineStartInput } from '../remote/pipeline'
import { useModel, useRemote } from '../state/RemoteProvider'
import { Alert } from '../ui/Alert'
import { Button } from '../ui/Button'
import { Chips, Field } from '../ui/Controls'
import { AGENT_LABEL } from '../ui/format'
import { Sheet } from '../ui/Sheet'
import { Txt } from '../ui/Txt'

function Group({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Txt variant="monoSm" color="textMuted">
        {label}
      </Txt>
      {children}
      {hint ? (
        <Txt variant="bodyXs" color="textMuted">
          {hint}
        </Txt>
      ) : null}
    </View>
  )
}

export function PipelineStartSheet({ jobIds, visible, onClose, onStarted }: { jobIds: readonly string[]; visible: boolean; onClose: () => void; onStarted: () => void }) {
  const model = useModel()
  const snap = useRemote()
  const agents = snap.status?.agents ?? REMOTE_AGENT_IDS.map((id) => ({ id, ready: true }))
  const ready = (id: RemoteAgentId) => agents.some((a) => a.id === id && a.ready)
  const firstReady = REMOTE_AGENT_IDS.find(ready) ?? 'claude'
  const [agent, setAgent] = useState<RemoteAgentId>(firstReady)
  const [fallback, setFallback] = useState<RemoteAgentId | 'none'>('none')
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY)
  const [maxCostUsd, setMaxCost] = useState('')
  const [maxRuns, setMaxRuns] = useState('')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (visible) setError(null)
  }, [visible])
  const running = snap.pipeline && (snap.pipeline.status === 'running' || snap.pipeline.status === 'waiting-limit' || snap.pipeline.status === 'paused')
  const start = () => {
    const out = pipelineStartInput({ jobIds, agent, fallback: fallback === 'none' ? null : fallback, concurrency, maxCostUsd, maxRuns })
    if ('error' in out) {
      setError(out.error)
      return
    }
    if (model.startPipeline(out.input)) onStarted()
  }
  const n = jobIds.length
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      eyebrow={`${n} saved job${n === 1 ? '' : 's'}`}
      title="Run unattended"
      footer={<Button size="lg" variant="primary" icon="sparkles" label={`Start pipeline · ${n} job${n === 1 ? '' : 's'}`} disabled={n === 0} onPress={start} />}
    >
      {running ? (
        <Alert tone="warning" title="A pipeline is already running">
          Your Mac runs one pipeline at a time per workspace. Stop the current one first, or queue these jobs instead.
        </Alert>
      ) : null}
      <Group label="Agent">
        <Chips label="Agent" value={agent} onChange={(v) => setAgent(v)} options={REMOTE_AGENT_IDS.map((id) => ({ value: id, label: AGENT_LABEL[id], disabled: !ready(id) }))} />
      </Group>
      <Group label="When it hits a usage limit" hint="Jobs not started yet switch to the fallback; without one the pipeline waits for the reset.">
        <Chips
          label="Fallback agent"
          value={fallback}
          onChange={(v) => setFallback(v)}
          options={[{ value: 'none' as const, label: 'Wait' }, ...REMOTE_AGENT_IDS.filter((id) => id !== agent).map((id) => ({ value: id, label: AGENT_LABEL[id], disabled: !ready(id) }))]}
        />
      </Group>
      <Group label="At a time" hint="Never more agent processes than this on your Mac.">
        <Chips label="Concurrency" value={concurrency} onChange={setConcurrency} options={Array.from({ length: REMOTE_MAX_CONCURRENCY }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} />
      </Group>
      <Group label="Budget (optional)" hint="New runs stop starting once either is reached.">
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Field accessibilityLabel="Spend limit in dollars" placeholder="Spend limit, $" keyboardType="decimal-pad" value={maxCostUsd} onChangeText={setMaxCost} />
          </View>
          <View style={{ flex: 1 }}>
            <Field accessibilityLabel="Most runs" placeholder="Most runs" keyboardType="number-pad" value={maxRuns} onChangeText={setMaxRuns} />
          </View>
        </View>
      </Group>
      {error ? <Alert tone="danger">{error}</Alert> : null}
      <Txt variant="bodyXs" color="textMuted">
        Same pre-flight, retries and limits as Run unattended on your Mac. Results stay Unreviewed; nothing is applied or submitted.
      </Txt>
    </Sheet>
  )
}
