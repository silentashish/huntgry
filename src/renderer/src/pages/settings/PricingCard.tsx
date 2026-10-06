import { useCallback, useEffect, useState } from 'react'
import { ActionIcon, Alert, Anchor, Badge, Button, Card, Group, Modal, NumberInput, ScrollArea, Stack, Table, Text, TextInput, Title, Tooltip } from '@mantine/core'
import { IconCloudDownload, IconPencil, IconPlus, IconRestore } from '@tabler/icons-react'
import type { ModelPrice } from '@shared/pricing'
import type { PricingState } from '@shared/usage-types'
import { api, errorText } from '../../api'

type Draft = {
  id: string
  label: string
  input: number | string
  cachedInput: number | string
  cacheWrite: number | string
  cacheWrite1h: number | string
  output: number | string
  source: string
  aliases: string[]
  /** Editing an existing model (its id is fixed). */
  existing: boolean
}

const EMPTY: Draft = { id: '', label: '', input: '', cachedInput: '', cacheWrite: '', cacheWrite1h: '', output: '', source: '', aliases: [], existing: false }

/** `raw.githubusercontent.com` for a URL; the text itself otherwise. */
function hostOf(source: string): string {
  try {
    return new URL(source).hostname
  } catch {
    return source
  }
}

const num = (v: number | string): number | undefined => (v === '' ? undefined : Number(v))
const rate = (v: number | undefined) => (v === undefined ? '—' : `$${Number(v.toFixed(4))}`)

/**
 * Settings → Pricing (#44): the USD-per-1M-token prices the run estimates use. Bundled figures
 * come from the providers' pricing pages; the user can change a model's price, add a model, and go
 * back to the bundled table. Stored in the app settings; estimates update without re-running.
 */
export function PricingCard() {
  const [state, setState] = useState<PricingState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const load = useCallback(async () => {
    try {
      setState(await api.runner.prices())
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function act(call: () => Promise<PricingState>): Promise<boolean> {
    setError(null)
    try {
      setState(await call())
      return true
    } catch (err) {
      setError(errorText(err))
      return false
    }
  }

  function edit(p: ModelPrice) {
    setDraft({
      id: p.id,
      label: p.label,
      input: p.input,
      cachedInput: p.cachedInput,
      cacheWrite: p.cacheWrite ?? '',
      cacheWrite1h: p.cacheWrite1h ?? '',
      output: p.output,
      source: p.custom ? p.source : '',
      aliases: p.aliases ?? [],
      existing: true
    })
  }

  async function save() {
    if (!draft) return
    setSaving(true)
    const ok = await act(() =>
      api.runner.setPrice({
        id: draft.id.trim(),
        label: draft.label.trim() || draft.id.trim(),
        input: num(draft.input),
        cachedInput: num(draft.cachedInput),
        cacheWrite: num(draft.cacheWrite),
        cacheWrite1h: num(draft.cacheWrite1h),
        output: num(draft.output),
        source: draft.source.trim() || undefined,
        aliases: draft.aliases
      })
    )
    setSaving(false)
    if (ok) setDraft(null)
  }

  async function sync() {
    setSyncing(true)
    await act(api.runner.syncPrices)
    setSyncing(false)
  }

  const bundled = new Set(state?.bundledIds ?? [])
  const synced = state?.synced ?? null
  const changed = state?.prices.some((p) => p.custom) ?? false

  return (
    <Card withBorder radius="md" padding="lg" data-testid="pricing-card">
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Title order={4}>Pricing</Title>
          <Text size="sm" c="dimmed" maw={640}>
            USD per million tokens, used for the estimated API cost of every run. On a subscription (Claude Pro/Max,
            ChatGPT, Google AI) nothing is billed per token: the estimate is what the same tokens would cost on the API.
            Changes apply to past runs too.
          </Text>
        </div>
        <Group gap="xs">
          <Button size="xs" leftSection={<IconCloudDownload size={14} />} loading={syncing} onClick={() => void sync()}>
            Sync prices
          </Button>
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setDraft({ ...EMPTY })}>
            Add model
          </Button>
          {changed && (
            <Button size="xs" variant="default" leftSection={<IconRestore size={14} />} onClick={() => void act(api.runner.resetPrices)}>
              Reset to defaults
            </Button>
          )}
        </Group>
      </Group>
      <Group gap="xs" mb="xs">
        <Text size="xs" c="dimmed" data-testid="pricing-sync-status">
          {synced
            ? `Last synced ${new Date(synced.syncedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} from ${hostOf(synced.source)} (${synced.models} models). Your own edits still win.`
            : 'Not synced: bundled prices. "Sync prices" fetches current prices for Claude, OpenAI and Gemini models from a public price list (a rough estimate, not your bill).'}
        </Text>
        {synced && (
          <Anchor component="button" size="xs" onClick={() => void act(api.runner.clearSyncedPrices)}>
            Clear synced prices
          </Anchor>
        )}
      </Group>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} mb="xs">
          {error}
        </Alert>
      )}
      <ScrollArea.Autosize mah={360}>
        <Table fz="xs" striped stickyHeader>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Model</Table.Th>
              <Table.Th ta="right">Input</Table.Th>
              <Table.Th ta="right">Cached</Table.Th>
              <Table.Th ta="right">Cache write</Table.Th>
              <Table.Th ta="right">Output</Table.Th>
              <Table.Th>Source</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {(state?.prices ?? []).map((p) => (
              <Table.Tr key={p.id} data-testid={`price-${p.id}`}>
                <Table.Td>
                  <Text size="xs" fw={500}>
                    {p.label}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace">
                    {p.id}
                  </Text>
                </Table.Td>
                <Table.Td ta="right">{rate(p.input)}</Table.Td>
                <Table.Td ta="right">{rate(p.cachedInput)}</Table.Td>
                <Table.Td ta="right">
                  {rate(p.cacheWrite)}
                  {p.cacheWrite1h !== undefined && (
                    <Text span size="xs" c="dimmed">
                      {' '}
                      / {rate(p.cacheWrite1h)} 1h
                    </Text>
                  )}
                </Table.Td>
                <Table.Td ta="right">{rate(p.output)}</Table.Td>
                <Table.Td>
                  {p.custom ? (
                    <Badge size="xs" variant="light" color="grape">
                      {bundled.has(p.id) ? 'changed' : 'added'}
                    </Badge>
                  ) : (
                    <>
                      {p.synced && (
                        <Badge size="xs" variant="light" color="teal" mr={4}>
                          synced
                        </Badge>
                      )}
                      <Anchor href={p.source} target="_blank" rel="noreferrer" size="xs">
                        {hostOf(p.source)}
                      </Anchor>
                    </>
                  )}{' '}
                  <Text span size="xs" c="dimmed">
                    {p.asOf}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={2} wrap="nowrap">
                    <Tooltip label="Edit">
                      <ActionIcon size="sm" variant="subtle" aria-label={`Edit ${p.id}`} onClick={() => edit(p)}>
                        <IconPencil size={14} />
                      </ActionIcon>
                    </Tooltip>
                    {p.custom && (
                      <Tooltip label={bundled.has(p.id) ? 'Back to the bundled price' : 'Remove'}>
                        <ActionIcon
                          size="sm"
                          variant="subtle"
                          color="gray"
                          aria-label={`Reset ${p.id}`}
                          onClick={() => void act(() => api.runner.removePrice(p.id))}
                        >
                          <IconRestore size={14} />
                        </ActionIcon>
                      </Tooltip>
                    )}
                  </Group>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </ScrollArea.Autosize>
      <Text size="xs" c="dimmed" mt="xs">
        Not modelled: long-context tiers (over 200k–272k input tokens in one request), batch, fast mode and regional
        pricing. A model missing here shows as "not priced".
      </Text>

      <Modal opened={draft !== null} onClose={() => setDraft(null)} title={draft?.existing ? `Price of ${draft.id}` : 'Add a model'}>
        {draft && (
          <Stack gap="xs">
            <TextInput
              label="Model id"
              description="As the agent reports it, e.g. gpt-6-sol or claude-opus-5-5"
              value={draft.id}
              disabled={draft.existing}
              onChange={(e) => setDraft({ ...draft, id: e.currentTarget.value })}
            />
            <TextInput label="Name" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.currentTarget.value })} />
            <Group grow>
              <NumberInput label="Input" prefix="$" min={0} decimalScale={4} value={draft.input} onChange={(v) => setDraft({ ...draft, input: v })} />
              <NumberInput
                label="Cached input"
                prefix="$"
                min={0}
                decimalScale={4}
                value={draft.cachedInput}
                onChange={(v) => setDraft({ ...draft, cachedInput: v })}
              />
            </Group>
            <Group grow>
              <NumberInput
                label="Cache write"
                description="Empty: as input"
                prefix="$"
                min={0}
                decimalScale={4}
                value={draft.cacheWrite}
                onChange={(v) => setDraft({ ...draft, cacheWrite: v })}
              />
              <NumberInput
                label="1-hour cache write"
                description="Claude only"
                prefix="$"
                min={0}
                decimalScale={4}
                value={draft.cacheWrite1h}
                onChange={(v) => setDraft({ ...draft, cacheWrite1h: v })}
              />
            </Group>
            <NumberInput label="Output (incl. reasoning)" prefix="$" min={0} decimalScale={4} value={draft.output} onChange={(v) => setDraft({ ...draft, output: v })} />
            <TextInput
              label="Source"
              placeholder="Where the price comes from (optional)"
              value={draft.source}
              onChange={(e) => setDraft({ ...draft, source: e.currentTarget.value })}
            />
            <Group justify="flex-end" mt="xs">
              <Button variant="default" onClick={() => setDraft(null)}>
                Cancel
              </Button>
              <Button onClick={save} loading={saving} disabled={!draft.id.trim()}>
                Save
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Card>
  )
}
