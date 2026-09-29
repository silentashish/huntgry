import { useEffect, useState, type ReactNode } from 'react'
import { Accordion, ActionIcon, Button, Group, SimpleGrid, Stack, Text, TextInput, Textarea, Tooltip } from '@mantine/core'

/** How one field of an entry is edited. `lines` edits a string[] as one item per line. */
export interface FieldSpec<T> {
  key: Extract<keyof T, string>
  label: string
  kind?: 'text' | 'textarea' | 'lines'
  placeholder?: string
  description?: string
  /** Columns out of 2; textareas and lines take the full row. */
  span?: 1 | 2
}

export function FieldGrid<T>({
  value,
  fields,
  onChange
}: {
  value: T
  fields: Array<FieldSpec<T>>
  onChange(next: T): void
}) {
  return (
    <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm" verticalSpacing="xs">
      {fields.map((f) => {
        const kind = f.kind ?? 'text'
        const span = kind === 'text' ? (f.span ?? 1) : 2
        const common = {
          key: f.key,
          label: f.label,
          placeholder: f.placeholder,
          description: f.description,
          style: span === 2 ? { gridColumn: '1 / -1' } : undefined
        }
        if (kind === 'lines') {
          return (
            <LinesInput
              {...common}
              value={value[f.key] as unknown as string[]}
              onChange={(lines) => onChange({ ...value, [f.key]: lines })}
            />
          )
        }
        const Input = kind === 'textarea' ? Textarea : TextInput
        return (
          <Input
            {...common}
            {...(kind === 'textarea' ? { autosize: true, minRows: 2 } : {})}
            value={value[f.key] as unknown as string}
            onChange={(e) => onChange({ ...value, [f.key]: e.currentTarget.value })}
          />
        )
      })}
    </SimpleGrid>
  )
}

/** A string[] edited as a textarea, one item per line. Blank lines are dropped on save. */
export function LinesInput({
  value,
  onChange,
  ...rest
}: {
  value: string[]
  onChange(lines: string[]): void
  label?: string
  placeholder?: string
  description?: string
  style?: React.CSSProperties
}) {
  return (
    <Textarea
      {...rest}
      autosize
      minRows={3}
      value={value.join('\n')}
      onChange={(e) => onChange(e.currentTarget.value.split('\n'))}
    />
  )
}

/**
 * A string[] edited as comma-separated text. The text is kept locally while
 * typing (so a trailing ", " survives) and parsed on every change.
 */
export function CommaListInput({
  value,
  onChange,
  label,
  placeholder
}: {
  value: string[]
  onChange(items: string[]): void
  label?: string
  placeholder?: string
}) {
  const joined = value.join(', ')
  const [text, setText] = useState(joined)
  useEffect(() => {
    // Only adopt outside changes (import, reload), not the echo of our own typing.
    if (parseCommaList(text).join(', ') !== joined) setText(joined)
  }, [joined])
  return (
    <TextInput
      label={label}
      placeholder={placeholder}
      value={text}
      onChange={(e) => {
        setText(e.currentTarget.value)
        onChange(parseCommaList(e.currentTarget.value))
      }}
    />
  )
}

/** Mirrors the main-process `splitList`: commas inside brackets do not split. */
export function parseCommaList(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const ch of text) {
    if ('([{'.includes(ch)) depth++
    if (')]}'.includes(ch)) depth = Math.max(0, depth - 1)
    if ((ch === ',' || ch === ';') && depth === 0) {
      out.push(current)
      current = ''
    } else current += ch
  }
  out.push(current)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * A reorderable list of entries rendered as an accordion. New entries open
 * automatically so the user can start typing.
 */
export function EntryList<T>({
  items,
  onChange,
  create,
  title,
  render,
  addLabel,
  empty
}: {
  items: T[]
  onChange(next: T[]): void
  create(): T
  title(item: T): string
  render(item: T, update: (next: T) => void): ReactNode
  addLabel: string
  empty: string
}) {
  const [open, setOpen] = useState<string[]>([])
  const update = (i: number, next: T) => onChange(items.map((it, j) => (j === i ? next : it)))
  const move = (i: number, by: number) => {
    const next = items.slice()
    const [it] = next.splice(i, 1)
    next.splice(i + by, 0, it)
    onChange(next)
    setOpen([])
  }
  const remove = (i: number) => {
    onChange(items.filter((_it, j) => j !== i))
    setOpen([])
  }
  return (
    <Stack gap="sm">
      {items.length === 0 ? (
        <Text c="dimmed" size="sm">
          {empty}
        </Text>
      ) : (
        <Accordion multiple variant="separated" value={open} onChange={setOpen}>
          {items.map((item, i) => (
            <Accordion.Item key={i} value={String(i)}>
              <Group wrap="nowrap" gap={4} pr="xs">
                <Accordion.Control style={{ flex: 1, minWidth: 0 }}>
                  <Text fw={500} truncate>
                    {title(item) || 'Untitled'}
                  </Text>
                </Accordion.Control>
                <Tooltip label="Move up">
                  <ActionIcon variant="subtle" color="gray" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Move down">
                  <ActionIcon
                    variant="subtle"
                    color="gray"
                    aria-label="Move down"
                    disabled={i === items.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    ↓
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Remove">
                  <ActionIcon variant="subtle" color="red" aria-label="Remove" onClick={() => remove(i)}>
                    ✕
                  </ActionIcon>
                </Tooltip>
              </Group>
              <Accordion.Panel>{render(item, (next) => update(i, next))}</Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
      )}
      <Group>
        <Button
          variant="light"
          size="xs"
          onClick={() => {
            onChange([...items, create()])
            setOpen([...open, String(items.length)])
          }}
        >
          {addLabel}
        </Button>
      </Group>
    </Stack>
  )
}
