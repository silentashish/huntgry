import { useEffect, useState } from 'react'
import { Alert, Button, Checkbox, Group, NumberInput, SegmentedControl, Switch, TextInput } from '@mantine/core'
import { AUTOMATION_BOUNDS, type AutomationSettings, type AutomationSettingsPatch } from '@shared/automation-types'
import { errorText } from '../../api'
import { SectionCard } from '../../components/ui'
import classes from './automation.module.css'

/**
 * The threshold, caps, run window and sources (#154). Edited as a draft and saved with one button; main clamps
 * every number to `AUTOMATION_BOUNDS` and the saved (clamped) values come back.
 */
export function Controls({ settings, save }: { settings: AutomationSettings; save(patch: AutomationSettingsPatch): Promise<AutomationSettings> }) {
  const [draft, setDraft] = useState(settings)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => setDraft(settings), [settings])
  const dirty = JSON.stringify(draft) !== JSON.stringify(settings)
  const set = (patch: Partial<AutomationSettings>) => setDraft((d) => ({ ...d, ...patch }))
  const num = (key: keyof typeof AUTOMATION_BOUNDS, label: string, extra: { prefix?: string; decimalScale?: number; description?: string } = {}) => (
    <NumberInput
      label={label}
      description={extra.description}
      min={AUTOMATION_BOUNDS[key].min}
      max={AUTOMATION_BOUNDS[key].max}
      prefix={extra.prefix}
      decimalScale={extra.decimalScale ?? 0}
      value={draft[key]}
      onChange={(v) => typeof v === 'number' && set({ [key]: v } as Partial<AutomationSettings>)}
    />
  )
  const window = draft.window

  async function onSave() {
    setBusy(true)
    setError(null)
    try {
      await save({
        threshold: draft.threshold,
        minRequirements: draft.minRequirements,
        perCompany: draft.perCompany,
        perDay: draft.perDay,
        maxCostUsd: draft.maxCostUsd,
        maxExplorePageLoads: draft.maxExplorePageLoads,
        window: draft.window,
        sources: draft.sources,
        coverLetter: draft.coverLetter
      })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      title="Controls"
      description="Which jobs a run picks, how many, and when it runs."
      aria-label="Automation controls"
      actions={
        <Group gap="xs">
          {dirty && (
            <Button variant="default" size="xs" onClick={() => setDraft(settings)}>
              Reset
            </Button>
          )}
          <Button variant="primary" size="xs" onClick={() => void onSave()} loading={busy} disabled={!dirty}>
            Save settings
          </Button>
        </Group>
      }
    >
      {error && (
        <Alert color="danger" variant="light" mb="md" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <div className={classes.controls}>
        {num('threshold', 'Match threshold', { description: 'Lowest match score picked' })}
        {num('minRequirements', 'Minimum requirements', { description: 'The posting must name this many' })}
        {num('perCompany', 'Per company', { description: 'Ready, in flight, applied (30 days)' })}
        {num('perDay', 'Per day', { description: 'Jobs entering tailoring' })}
        {num('maxCostUsd', 'Cost cap per run', { prefix: '$', decimalScale: 2, description: 'Tailoring cost' })}
        {num('maxExplorePageLoads', 'Jobright pages per run', { description: 'For Discover rows' })}
      </div>
      <Group mt="lg" gap="lg" align="flex-end" wrap="wrap">
        <div>
          <SegmentedControl
            aria-label="Run window"
            size="xs"
            value={window.mode}
            onChange={(v) => set({ window: v === 'anytime' ? { mode: 'anytime' } : { mode: 'window', start: '22:00', end: '07:00' } })}
            data={[
              { value: 'window', label: 'Run window' },
              { value: 'anytime', label: 'Anytime' }
            ]}
          />
        </div>
        {window.mode === 'window' && (
          <>
            <TextInput type="time" label="From" w={120} value={window.start} onChange={(e) => set({ window: { ...window, start: e.currentTarget.value } })} />
            <TextInput type="time" label="To" w={120} value={window.end} onChange={(e) => set({ window: { ...window, end: e.currentTarget.value } })} />
          </>
        )}
        <Checkbox label="Saved jobs" checked={draft.sources.jobs} onChange={(e) => set({ sources: { ...draft.sources, jobs: e.currentTarget.checked } })} />
        <Checkbox label="Discover" checked={draft.sources.explore} onChange={(e) => set({ sources: { ...draft.sources, explore: e.currentTarget.checked } })} />
        <Switch label="Cover letters" checked={draft.coverLetter} onChange={(e) => set({ coverLetter: e.currentTarget.checked })} />
      </Group>
    </SectionCard>
  )
}
