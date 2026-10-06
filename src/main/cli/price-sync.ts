import { MODEL_PRICES, normalizeModelId, type ModelPrice, type SyncedPrices } from '@shared/pricing'

/**
 * Settings → Pricing → **Sync prices** (#44): fetches a public price list in the main process,
 * only when the user clicks. The estimate is a rough "what would this cost on the API", so a
 * community list is good enough; every number read is checked, and a failure never touches the
 * prices in use.
 *
 * Sources, in order: LiteLLM's `model_prices_and_context_window.json` (per-token USD), then
 * OpenRouter's `/api/v1/models` (per-token USD as strings). Only the providers Huntgry's agents
 * run are kept: Anthropic (Claude, and Claude through agy), OpenAI (Codex) and Google Gemini (agy).
 */

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/models'

/** Above this a per-1M price is taken as a data error. */
export const MAX_PRICE_PER_M = 1000
const TIMEOUT_MS = 15_000
/** The LiteLLM list is ~3 MB today. */
const MAX_BYTES = 20 * 1024 * 1024

type Provider = 'anthropic' | 'openai' | 'google'

/** Our ids per provider; anything else from the list is ignored. */
const ID_PATTERN: Record<Provider, RegExp> = {
  anthropic: /^claude-[a-z0-9.-]+$/,
  openai: /^(?:gpt-[a-z0-9.-]+|o\d[a-z0-9.-]*|codex-[a-z0-9.-]+)$/,
  google: /^gemini-[a-z0-9.-]+$/
}

/** Not chat models, though they share the providers' prefixes. */
const NOT_CHAT = /(?:^|-)(?:image|audio|tts|realtime|transcribe|embedding|search-preview|live)(?:-|$)/

/** A per-token USD figure → per 1M, or `undefined` when absent; `null` when present but not a sane price. */
function perMillion(v: unknown): number | undefined | null {
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'string' ? Number(v) : v
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return null
  const m = Math.round(n * 1e6 * 1e6) / 1e6
  return m > MAX_PRICE_PER_M ? null : m
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Bundled ids by every name they are known by, so a synced price replaces the bundled entry it means. */
function bundledIdOf(id: string): string | undefined {
  return MODEL_PRICES.find((p) => [p.id, ...(p.aliases ?? [])].some((n) => normalizeModelId(n) === id))?.id
}

const PROVIDER_LABEL: Record<Provider, string> = { anthropic: 'Claude', openai: 'OpenAI', google: 'Gemini' }

function labelOf(id: string, provider: Provider): string {
  const bundled = MODEL_PRICES.find((p) => p.id === id)
  if (bundled) return bundled.label
  return `${id} (${PROVIDER_LABEL[provider]})`
}

interface RawPrice {
  name: string
  provider: Provider
  input: unknown
  output: unknown
  cachedInput?: unknown
  cacheWrite?: unknown
  cacheWrite1h?: unknown
}

/**
 * Checked prices from raw entries: our providers only, a known id shape, input and output present,
 * every figure finite, ≥ 0 and ≤ `MAX_PRICE_PER_M` (one bad figure drops the model). The first
 * entry of a normalized id wins, except that an entry named exactly by the id beats a dated one.
 */
export function toModelPrices(raw: readonly RawPrice[], source: string, asOf: string): ModelPrice[] {
  const out = new Map<string, { price: ModelPrice; exact: boolean }>()
  for (const r of raw) {
    const norm = normalizeModelId(r.name)
    if (!ID_PATTERN[r.provider].test(norm) || NOT_CHAT.test(norm)) continue
    const input = perMillion(r.input)
    const output = perMillion(r.output)
    const cachedInput = perMillion(r.cachedInput)
    const cacheWrite = perMillion(r.cacheWrite)
    const cacheWrite1h = perMillion(r.cacheWrite1h)
    if (input == null || output == null || cachedInput === null || cacheWrite === null || cacheWrite1h === null) continue
    // A list's placeholder, not a price.
    if (input === 0 && output === 0) continue
    const id = bundledIdOf(norm) ?? norm
    const exact = r.name.toLowerCase() === norm
    const seen = out.get(id)
    if (seen && (seen.exact || !exact)) continue
    out.set(id, {
      exact,
      price: {
        id,
        label: labelOf(id, r.provider),
        input,
        // No cache figure: priced as plain input (an over- rather than an under-estimate).
        cachedInput: cachedInput ?? input,
        ...(cacheWrite !== undefined ? { cacheWrite } : {}),
        ...(cacheWrite1h !== undefined ? { cacheWrite1h } : {}),
        output,
        source,
        asOf
      }
    })
  }
  return [...out.values()].map((v) => v.price)
}

const LITELLM_PROVIDERS: Record<string, Provider> = {
  anthropic: 'anthropic',
  openai: 'openai',
  'text-completion-openai': 'openai',
  gemini: 'google',
  'vertex_ai-language-models': 'google'
}

/**
 * LiteLLM's list: `{ "<model>": { litellm_provider, mode, input_cost_per_token, … } }`. Cloud
 * resellers (Bedrock, Azure, Vertex's Claude, OpenRouter …) have their own provider names and are
 * skipped; `gemini/<id>` keys are Google's own API.
 */
export function parseLiteLlm(json: unknown, asOf: string): ModelPrice[] {
  if (!isObj(json)) throw new Error('The LiteLLM price list is not a JSON object.')
  const raw: RawPrice[] = []
  for (const [key, v] of Object.entries(json)) {
    if (!isObj(v) || typeof v.litellm_provider !== 'string') continue
    const provider = LITELLM_PROVIDERS[v.litellm_provider]
    if (!provider) continue
    if (v.mode !== undefined && v.mode !== 'chat' && v.mode !== 'responses') continue
    const name = key.replace(/^gemini\//, '')
    if (name.includes('/')) continue
    raw.push({
      name,
      provider,
      input: v.input_cost_per_token,
      output: v.output_cost_per_token,
      cachedInput: v.cache_read_input_token_cost,
      cacheWrite: v.cache_creation_input_token_cost,
      cacheWrite1h: v.cache_creation_input_token_cost_above_1hr
    })
  }
  return toModelPrices(raw, LITELLM_URL, asOf)
}

const OPENROUTER_PROVIDERS: Record<string, Provider> = { anthropic: 'anthropic', openai: 'openai', google: 'google' }

/**
 * OpenRouter's list: `{ data: [{ id: "anthropic/claude-opus-5.5", pricing: { prompt, completion,
 * input_cache_read, input_cache_write, input_cache_write_1h } }] }`, prices as decimal strings.
 * Variants (`…:batch`, `…:free`) are skipped.
 */
export function parseOpenRouter(json: unknown, asOf: string): ModelPrice[] {
  if (!isObj(json) || !Array.isArray(json.data)) throw new Error('The OpenRouter model list has no "data" array.')
  const raw: RawPrice[] = []
  for (const m of json.data) {
    if (!isObj(m) || typeof m.id !== 'string' || !isObj(m.pricing) || m.id.includes(':')) continue
    const [vendor, name, ...rest] = m.id.split('/')
    const provider = OPENROUTER_PROVIDERS[vendor]
    if (!provider || !name || rest.length > 0) continue
    const p = m.pricing
    raw.push({
      name,
      provider,
      input: p.prompt,
      output: p.completion,
      cachedInput: p.input_cache_read,
      cacheWrite: p.input_cache_write,
      cacheWrite1h: p.input_cache_write_1h
    })
  }
  return toModelPrices(raw, OPENROUTER_URL, asOf)
}

/**
 * GETs `url` as JSON with a timeout covering the whole exchange (headers and body) and a size cap.
 * Every way out releases the request: on any error the response body is cancelled and the request
 * aborted, so a rejected source never keeps a socket open while the next one is tried.
 */
export async function fetchJson(url: string, fetcher: typeof fetch = fetch, timeoutMs = TIMEOUT_MS): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  let res: Response | undefined
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    res = await fetcher(url, { signal: controller.signal, headers: { accept: 'application/json' }, redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const length = Number(res.headers.get('content-length') ?? 0)
    if (length > MAX_BYTES) throw new Error('the response is too large')
    if (!res.body) throw new Error('empty response')
    reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BYTES) throw new Error('the response is too large')
      chunks.push(value)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('the response is not JSON')
    }
  } catch (err) {
    // Release the body and the connection first; keep the original reason.
    controller.abort()
    // A locked body is cancelled through its reader.
    await (reader ? reader.cancel() : res?.body?.cancel())?.catch(() => undefined)
    if (timedOut) throw new Error(`no answer within ${timeoutMs / 1000} s`)
    throw err
  } finally {
    clearTimeout(timer)
  }
}

const SOURCES = [
  { name: 'LiteLLM', url: LITELLM_URL, parse: parseLiteLlm },
  { name: 'OpenRouter', url: OPENROUTER_URL, parse: parseOpenRouter }
] as const

/**
 * Prices from the first source that answers with at least one usable model. Throws, naming why
 * each source failed, when none does: the caller then keeps the prices it has.
 */
export async function fetchSyncedPrices(fetcher: typeof fetch = fetch, now = new Date()): Promise<SyncedPrices> {
  const asOf = now.toISOString().slice(0, 10)
  const problems: string[] = []
  for (const s of SOURCES) {
    try {
      const models = s.parse(await fetchJson(s.url, fetcher), asOf)
      if (models.length === 0) throw new Error('no Claude, OpenAI or Gemini prices in it')
      return { syncedAt: now.toISOString(), source: s.url, models }
    } catch (err) {
      problems.push(`${s.name}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  throw new Error(`Could not sync prices; the current prices are kept. ${problems.join('; ')}.`)
}
