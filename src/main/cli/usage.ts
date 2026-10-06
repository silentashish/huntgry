import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { effectivePrices, MODEL_PRICES, priceRun, requireModelPrice, runTotals, type ModelPrice, type PricingOverrides, type SyncedPrices } from '@shared/pricing'
import { isAgentId, type RunStatus, type RunSummary } from '@shared/runner-types'
import { summarizeUsage } from '@shared/usage'
import { USAGE_RANGES, type PricingState, type UsageFilter, type UsageRange, type UsageSummary } from '@shared/usage-types'
import { loadSettings, saveSettings } from '../workspace/settings'
import { backfillMetrics, legacyFields } from './metrics'
import { listRuns, readEvents, runDir } from './runs'

/**
 * Run observability in the main process (#44): the price table in use (bundled + Settings →
 * Pricing), and the usage summary over a workspace's `run.json` files. No database, like
 * `runs.ts`: runs are small and already on disk. Old runs get their metrics rebuilt from
 * `events.jsonl` once per change of their files (cached in memory, never written back, so a
 * run that is being resumed is never overwritten).
 */

/** The prices in use, kept in memory; `loadPrices` reads the settings file at startup. */
let prices: ModelPrice[] = [...MODEL_PRICES]

export function currentPrices(): readonly ModelPrice[] {
  return prices
}

/** The last sync, for "Last synced … from …". */
let lastSync: PricingState['synced'] = null

/** Entries from the settings file that are still valid prices (the file is hand-editable). */
function validPrices(v: unknown): ModelPrice[] {
  if (!Array.isArray(v)) return []
  return v.flatMap((m) => {
    try {
      return [requireModelPrice(m)]
    } catch {
      return []
    }
  })
}

/** The stored layers, checked: the user's edits and the last sync. */
async function storedPricing(settingsFile: string): Promise<PricingOverrides> {
  const stored = (await loadSettings(settingsFile)).pricing
  const synced = stored?.synced
  return {
    models: validPrices(stored?.models),
    ...(synced && typeof synced.syncedAt === 'string' && typeof synced.source === 'string'
      ? { synced: { syncedAt: synced.syncedAt, source: synced.source, models: validPrices(synced.models) } }
      : {})
  }
}

function apply(o: PricingOverrides): void {
  prices = effectivePrices(o)
  lastSync = o.synced ? { syncedAt: o.synced.syncedAt, source: o.synced.source, models: o.synced.models.length } : null
}

export async function loadPrices(settingsFile: string): Promise<readonly ModelPrice[]> {
  apply(await storedPricing(settingsFile))
  return prices
}

export function pricingState(): PricingState {
  return { prices: [...prices], bundledIds: MODEL_PRICES.map((m) => m.id), synced: lastSync }
}

async function savePricing(settingsFile: string, change: (o: PricingOverrides) => PricingOverrides): Promise<PricingState> {
  const next = change(await storedPricing(settingsFile))
  await saveSettings(settingsFile, { pricing: next })
  apply(next)
  return pricingState()
}

/** Adds or replaces the user's price for a model. */
export function setPrice(settingsFile: string, input: unknown): Promise<PricingState> {
  const price = requireModelPrice(input)
  return savePricing(settingsFile, (o) => ({ ...o, models: [...o.models.filter((m) => m.id !== price.id), price] }))
}

/** Drops the user's price for `id` (a bundled model goes back to its bundled price). */
export function removePrice(settingsFile: string, id: unknown): Promise<PricingState> {
  if (typeof id !== 'string') throw new Error('Unknown model.')
  return savePricing(settingsFile, (o) => ({ ...o, models: o.models.filter((m) => m.id !== id) }))
}

/** Drops the user's edits (synced prices, if any, then apply over the bundled table). */
export function resetPrices(settingsFile: string): Promise<PricingState> {
  return savePricing(settingsFile, (o) => ({ ...o, models: [] }))
}

/**
 * Settings → Pricing → Sync prices: fetches the public price list (see `price-sync.ts`) and stores
 * it as its own layer. On any failure it throws and leaves the stored prices as they were.
 */
export async function syncPrices(settingsFile: string, fetchPrices: () => Promise<SyncedPrices>): Promise<PricingState> {
  const synced = await fetchPrices()
  return savePricing(settingsFile, (o) => ({ ...o, synced }))
}

/** Drops the synced layer: the bundled table (and the user's edits) again. */
export function clearSyncedPrices(settingsFile: string): Promise<PricingState> {
  return savePricing(settingsFile, (o) => ({ models: o.models }))
}

/** A run with its estimates at the current prices. */
export function withPrices<R extends Pick<RunSummary, 'metrics' | 'totals'>>(run: R): R {
  return priceRun(run, prices)
}

const STATUSES: RunStatus[] = ['running', 'waiting', 'finished', 'failed', 'stopped']

/** Checks a filter from the renderer. */
export function requireUsageFilter(input: unknown): UsageFilter {
  if (input === undefined || input === null) return {}
  if (typeof input !== 'object') throw new Error('Invalid filter.')
  const f = input as Record<string, unknown>
  const strings = (v: unknown, max = 50): string[] | undefined =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.length <= 300).slice(0, max) : undefined
  const out: UsageFilter = {}
  if (USAGE_RANGES.includes(f.range as UsageRange)) out.range = f.range as UsageRange
  const agents = Array.isArray(f.agents) ? f.agents.filter(isAgentId) : undefined
  if (agents?.length) out.agents = agents
  const models = strings(f.models)
  if (models?.length) out.models = models
  const statuses = Array.isArray(f.statuses) ? f.statuses.filter((s): s is RunStatus => STATUSES.includes(s as RunStatus)) : undefined
  if (statuses?.length) out.statuses = statuses
  if (typeof f.batchId === 'string' && /^b-[\w-]{1,80}$/.test(f.batchId)) out.batchId = f.batchId
  return out
}

/** Backfilled metrics per run, keyed by the mtimes of its two files. */
const backfillCache = new Map<string, { key: string; patch: Partial<RunSummary> }>()

async function mtimes(workspace: string, id: string): Promise<string> {
  const dir = runDir(workspace, id)
  const [a, b] = await Promise.all(
    ['run.json', 'events.jsonl'].map((f) =>
      stat(join(dir, f)).then(
        (s) => `${s.mtimeMs}:${s.size}`,
        () => '-'
      )
    )
  )
  return `${workspace}\u0000${a}\u0000${b}`
}

/** A run with metrics: its own, or rebuilt from its events when it was recorded before #44. */
export async function withMetrics(workspace: string, run: RunSummary): Promise<RunSummary> {
  if (run.metrics) return run
  const key = await mtimes(workspace, run.id)
  const cached = backfillCache.get(run.id)
  if (cached?.key === key) return { ...run, ...cached.patch }
  const { metrics, counters, model } = backfillMetrics(run, await readEvents(workspace, run.id), run.model ?? null, prices)
  const patch: Partial<RunSummary> = {
    metrics,
    totals: runTotals(metrics),
    cliCounters: counters,
    model,
    backfilled: true,
    ...legacyFields(metrics, run.agent)
  }
  if (patch.usage === undefined) delete patch.usage
  backfillCache.set(run.id, { key, patch })
  return { ...run, ...patch }
}

/**
 * The Dashboard's usage summary of `workspace`. `live` returns the in-memory summary of a run
 * that has a process (fresher than its `run.json`).
 */
export async function usageSummary(
  workspace: string,
  filter: UsageFilter,
  live: (id: string) => RunSummary | null = () => null,
  now = Date.now()
): Promise<UsageSummary> {
  const runs = await Promise.all(
    (await listRuns(workspace)).map(async (r) => withPrices(await withMetrics(workspace, live(r.id) ?? r)))
  )
  return summarizeUsage(runs, filter, now, prices)
}
