import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { effectivePrices, findPrice, MODEL_PRICES, type SyncedPrices } from '@shared/pricing'
import { fetchJson, fetchSyncedPrices, LITELLM_URL, OPENROUTER_URL, parseLiteLlm, parseOpenRouter } from './price-sync'
import { clearSyncedPrices, currentPrices, loadPrices, pricingState, resetPrices, setPrice, syncPrices } from './usage'

/**
 * Settings → Pricing → Sync prices (#44). The fixtures are small extracts of the two public lists
 * (recorded 2026-10-06), plus a few entries named `*-test-*` added by hand with bad values.
 */

const FIXTURES = join(__dirname, 'fixtures/prices')
const read = async (name: string): Promise<unknown> => JSON.parse(await readFile(join(FIXTURES, name), 'utf8'))
const AS_OF = '2026-10-06'

function response(body: string, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, { status: init.status ?? 200, headers: init.headers })
}

/** A `fetch` answering per URL (no network in tests). */
function fakeFetch(answers: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input)
    const answer = answers[url]
    if (!answer) throw new TypeError('fetch failed')
    return answer()
  }) as typeof fetch
}

describe('parsing the price lists', () => {
  it('LiteLLM: per-token USD → per 1M, our three providers only, one entry per model id', async () => {
    const models = parseLiteLlm(await read('litellm.json'), AS_OF)
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('claude-haiku-4-5')).toMatchObject({
      input: 1,
      cachedInput: 0.1,
      cacheWrite: 1.25,
      cacheWrite1h: 2,
      output: 5,
      source: LITELLM_URL,
      asOf: AS_OF,
      label: 'Claude Haiku 4.5'
    })
    expect(byId.get('claude-opus-5-5')).toMatchObject({ input: 4, cachedInput: 0.2, output: 20 })
    expect(byId.get('gpt-6-sol')).toMatchObject({ input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 })
    expect(byId.get('gemini-3.8-flash')).toMatchObject({ input: 0.75, cachedInput: 0.075, output: 3.75 })
    // `gemini/<id>` is Google's own API; the synced price replaces the bundled id it means.
    expect(byId.get('gemini-3.1-pro-preview')).toMatchObject({ input: 2, output: 12 })
    // Dated and undated keys of one model give one entry.
    expect(models.filter((m) => m.id === 'claude-haiku-4-5')).toHaveLength(1)
    // Resellers (Azure, Bedrock), other providers and non-chat models are ignored.
    const ids = models.map((m) => m.id)
    for (const id of ids) expect(id).toMatch(/^(claude-|gpt-|gemini-|o\d)/)
    expect(ids.some((id) => /codestral|transcribe|realtime|sample/.test(id))).toBe(false)
  })

  it('OpenRouter: decimal strings, vendor/model ids, variants and other vendors skipped', async () => {
    const models = parseOpenRouter(await read('openrouter.json'), AS_OF)
    const byId = new Map(models.map((m) => [m.id, m]))
    expect(byId.get('claude-opus-5-5')).toMatchObject({ input: 4, cachedInput: 0.2, cacheWrite: 5, cacheWrite1h: 8, output: 20, source: OPENROUTER_URL })
    expect(byId.get('claude-haiku-4-5')).toMatchObject({ input: 1, output: 5 })
    expect(byId.get('gpt-6-sol')).toMatchObject({ input: 2, cachedInput: 0.2, output: 10 })
    expect(byId.get('gemini-3.8-flash')).toMatchObject({ input: 0.75, output: 3.75 })
    // A model the bundled table does not have is added under its own id.
    expect(byId.get('gpt-6.1-sol-pro')).toMatchObject({ label: 'gpt-6.1-sol-pro (OpenAI)' })
    expect([...byId.keys()].every((id) => /^(claude-|gpt-|gemini-)/.test(id))).toBe(true)
    expect(models).toHaveLength(5)
  })

  it('rejects bad values: negative, absurd (> $1000/M), not a number, all-zero placeholders', async () => {
    const lite = parseLiteLlm(await read('litellm.json'), AS_OF).map((m) => m.id)
    for (const bad of ['claude-test-negative', 'gpt-test-absurd', 'gemini-test-text', 'claude-test-zero']) expect(lite).not.toContain(bad)
    expect(parseOpenRouter(await read('openrouter.json'), AS_OF).map((m) => m.id)).not.toContain('gpt-test-negative')
    expect(parseLiteLlm({ 'claude-x-9': { litellm_provider: 'anthropic', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: Infinity } }, AS_OF)).toEqual([])
    expect(() => parseLiteLlm([1, 2], AS_OF)).toThrow(/not a JSON object/)
    expect(() => parseOpenRouter({ models: [] }, AS_OF)).toThrow(/data/)
  })

  it('ignores every provider but Anthropic, OpenAI and Google, whatever the model is called', () => {
    const lite = parseLiteLlm(
      {
        'claude-opus-5-5': { litellm_provider: 'bedrock', mode: 'chat', input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
        'gpt-6-sol': { litellm_provider: 'azure', mode: 'chat', input_cost_per_token: 9e-6, output_cost_per_token: 9e-6 },
        'mistral-large': { litellm_provider: 'mistral', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
        // A Google key that is not a Gemini model.
        'gemma-4': { litellm_provider: 'gemini', mode: 'chat', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 }
      },
      AS_OF
    )
    expect(lite).toEqual([])
    const or = parseOpenRouter(
      { data: [{ id: 'mistralai/claude-lookalike', pricing: { prompt: '0.000001', completion: '0.000001' } }, { id: 'meta-llama/llama-5', pricing: { prompt: '0', completion: '0.1' } }] },
      AS_OF
    )
    expect(or).toEqual([])
  })
})

describe('fetching', () => {
  it('uses LiteLLM when it answers', async () => {
    const lite = await readFile(join(FIXTURES, 'litellm.json'), 'utf8')
    const synced = await fetchSyncedPrices(fakeFetch({ [LITELLM_URL]: () => response(lite) }), new Date('2026-10-06T19:00:00Z'))
    expect(synced).toMatchObject({ source: LITELLM_URL, syncedAt: '2026-10-06T19:00:00.000Z' })
    expect(synced.models.length).toBeGreaterThan(3)
  })

  it('falls back to OpenRouter when LiteLLM fails (403, bad JSON, offline)', async () => {
    const or = await readFile(join(FIXTURES, 'openrouter.json'), 'utf8')
    for (const lite of [() => response('Forbidden', { status: 403 }), () => response('{not json'), () => Promise.reject(new TypeError('offline'))]) {
      const synced = await fetchSyncedPrices(fakeFetch({ [LITELLM_URL]: lite, [OPENROUTER_URL]: () => response(or) }))
      expect(synced.source).toBe(OPENROUTER_URL)
    }
  })

  it('fails with both reasons when neither source works', async () => {
    await expect(
      fetchSyncedPrices(fakeFetch({ [LITELLM_URL]: () => response('x', { status: 503 }), [OPENROUTER_URL]: () => response('{"data": []}') }))
    ).rejects.toThrow(/current prices are kept.*LiteLLM: HTTP 503.*OpenRouter: no Claude, OpenAI or Gemini prices/)
  })

  it('caps the response size', async () => {
    await expect(fetchJson(LITELLM_URL, fakeFetch({ [LITELLM_URL]: () => response('{}', { headers: { 'content-length': String(500 * 1024 * 1024) } }) }))).rejects.toThrow(
      /too large/
    )
    const huge = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1024 * 1024))
      }
    })
    await expect(fetchJson(LITELLM_URL, fakeFetch({ [LITELLM_URL]: () => new Response(huge) }))).rejects.toThrow(/too large/)
  })
})

describe('the synced layer', () => {
  let dir: string
  let file: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'huntgry-prices-'))
    file = join(dir, 'settings.json')
    await writeFile(file, '{}')
    await loadPrices(file)
  })
  afterEach(() => rm(dir, { recursive: true, force: true }))

  const synced = (over: Partial<SyncedPrices> = {}): SyncedPrices => ({
    syncedAt: '2026-10-06T19:00:00.000Z',
    source: LITELLM_URL,
    models: [
      { ...MODEL_PRICES.find((m) => m.id === 'claude-haiku-4-5')!, input: 1.5, source: LITELLM_URL, asOf: AS_OF },
      { id: 'gpt-6.1-sol-pro', label: 'gpt-6.1-sol-pro (OpenAI)', input: 20, cachedInput: 2, output: 80, source: LITELLM_URL, asOf: AS_OF }
    ],
    ...over
  })

  it('precedence: the user\'s edits, then synced, then bundled; reset keeps the sync, clear drops it', async () => {
    let state = await syncPrices(file, async () => synced())
    expect(state.synced).toEqual({ syncedAt: '2026-10-06T19:00:00.000Z', source: LITELLM_URL, models: 2 })
    expect(findPrice('claude-haiku-4-5-20251001', currentPrices())).toMatchObject({ input: 1.5, synced: true })
    expect(findPrice('gpt-6.1-sol-pro', currentPrices())).toMatchObject({ input: 20, synced: true })
    expect(findPrice('claude-opus-5-5', currentPrices())).toMatchObject({ input: 4 })
    expect(findPrice('claude-opus-5-5', currentPrices())?.synced).toBeUndefined()

    state = await setPrice(file, { id: 'claude-haiku-4-5', input: 3, cachedInput: 0.3, output: 15 })
    expect(findPrice('claude-haiku-4-5', currentPrices())).toMatchObject({ input: 3, custom: true })
    expect(state.synced?.models).toBe(2)

    await resetPrices(file)
    expect(findPrice('claude-haiku-4-5', currentPrices())).toMatchObject({ input: 1.5, synced: true })

    state = await clearSyncedPrices(file)
    expect(state.synced).toBeNull()
    expect(findPrice('claude-haiku-4-5', currentPrices())).toMatchObject({ input: 1 })
    expect(currentPrices().some((m) => m.id === 'gpt-6.1-sol-pro')).toBe(false)
  })

  it('a failed sync keeps the prices in use and on disk', async () => {
    await syncPrices(file, async () => synced())
    const before = await readFile(file, 'utf8')
    await expect(syncPrices(file, async () => Promise.reject(new Error('offline')))).rejects.toThrow('offline')
    expect(await readFile(file, 'utf8')).toBe(before)
    expect(findPrice('claude-haiku-4-5', currentPrices())).toMatchObject({ input: 1.5 })
    expect(pricingState().synced?.models).toBe(2)
  })

  it('reloads the layers from the settings file, dropping entries that are not valid prices', async () => {
    await writeFile(
      file,
      JSON.stringify({
        pricing: {
          models: [],
          synced: { ...synced(), models: [...synced().models, { id: 'claude-bad', input: -1, cachedInput: 0, output: 1 }] }
        }
      })
    )
    await loadPrices(file)
    expect(pricingState().synced?.models).toBe(2)
    expect(findPrice('claude-bad', currentPrices())).toBeNull()
    // Precedence as a pure function.
    const table = effectivePrices({ models: [], synced: synced() })
    expect(table.filter((m) => m.id === 'claude-haiku-4-5')).toHaveLength(1)
  })
})
