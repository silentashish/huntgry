import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { Accordion, ActionIcon, Button, TextInput, Textarea, Tooltip } from '@mantine/core'
import { IconChevronDown, IconChevronRight, IconChevronUp, IconPlus, IconTrash } from '@tabler/icons-react'
import classes from './editor.module.css'

/** How one field of an entry is edited. `lines` edits a string[] as one item per line. */
export interface FieldSpec<T> {
  key: Extract<keyof T, string>
  label: string
  kind?: 'text' | 'textarea' | 'lines'
  placeholder?: string
  description?: string
  /** Columns out of 12 (Figma rows of 3 and 4 fields); text defaults to 6, textareas and lines take the row. */
  cols?: 3 | 4 | 6 | 12
}

const span = (cols: number) => ({ '--field-cols': cols }) as CSSProperties

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
    <div className={classes.fieldGrid}>
      {fields.map((f) => {
        const kind = f.kind ?? 'text'
        const common = {
          key: f.key,
          label: f.label,
          placeholder: f.placeholder,
          description: f.description,
          className: classes.field,
          style: span(kind === 'text' ? (f.cols ?? 6) : 12)
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
            inputWrapperOrder={['label', 'input', 'description', 'error']}
            {...(kind === 'textarea' ? { autosize: true, minRows: 2 } : {})}
            value={value[f.key] as unknown as string}
            onChange={(e) => onChange({ ...value, [f.key]: e.currentTarget.value })}
          />
        )
      })}
    </div>
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
  className?: string
  style?: CSSProperties
}) {
  return (
    <Textarea
      {...rest}
      inputWrapperOrder={['label', 'input', 'description', 'error']}
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

/** "Add …" in the Figma secondary small style. */
export function AddButton({ children, onClick }: { children: ReactNode; onClick(): void }) {
  return (
    <Button variant="secondary" size="xs" leftSection={<IconPlus size={14} />} onClick={onClick}>
      {children}
    </Button>
  )
}

/**
 * The head of an editor section (Figma: "Experience  4 entries · …  + Add experience"):
 * a Geist 20 title, a muted line and the section's action.
 */
export function SectionHead({
  title,
  meta,
  action,
  order = 3
}: {
  title: ReactNode
  meta?: ReactNode
  action?: ReactNode
  order?: 3 | 4
}) {
  const Heading = order === 3 ? 'h3' : 'h4'
  return (
    <div className={classes.sectionHead} data-order={order}>
      <Heading className={classes.sectionTitle}>{title}</Heading>
      {meta != null && <span className={classes.sectionMeta}>{meta}</span>}
      {action != null && <span className={classes.sectionAction}>{action}</span>}
    </div>
  )
}

/**
 * A reorderable list of entries rendered as cards that fold open (Figma: the Experience cards).
 * New entries open automatically so the user can start typing.
 */
export function EntryList<T>({
  items,
  onChange,
  create,
  title,
  meta,
  render,
  heading,
  summary,
  headingOrder = 3,
  addLabel,
  empty
}: {
  items: T[]
  onChange(next: T[]): void
  create(): T
  /** The card title, e.g. "Senior Engineer · Acme". */
  title(item: T): string
  /** The mono line after the title, e.g. the dates. */
  meta?(item: T): string
  render(item: T, update: (next: T) => void): ReactNode
  /** Section title above the cards. */
  heading: string
  /** Muted line beside the section title. */
  summary?: string
  headingOrder?: 3 | 4
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
  const add = () => {
    onChange([...items, create()])
    setOpen([...open, String(items.length)])
  }
  return (
    <div className={classes.section}>
      <SectionHead title={heading} meta={summary} order={headingOrder} action={<AddButton onClick={add}>{addLabel}</AddButton>} />
      {items.length === 0 ? (
        <p className={classes.empty}>{empty}</p>
      ) : (
        <Accordion
          multiple
          value={open}
          onChange={setOpen}
          chevronPosition="left"
          disableChevronRotation
          classNames={{ root: classes.entries, item: classes.entry, control: classes.entryControl, chevron: classes.entryChevron, label: classes.entryLabel, content: classes.entryContent }}
        >
          {items.map((item, i) => {
            const name = title(item)
            const sub = meta?.(item) ?? ''
            const isOpen = open.includes(String(i))
            return (
              <Accordion.Item key={i} value={String(i)}>
                <div className={classes.entryHead}>
                  <Accordion.Control
                    aria-label={[name || 'Untitled', sub].filter(Boolean).join(' · ')}
                    chevron={isOpen ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
                  >
                    <span className={classes.entryTitle}>{name || 'Untitled'}</span>
                    {sub && <span className={classes.entryMeta}>{sub}</span>}
                  </Accordion.Control>
                  <Tooltip label="Move up">
                    <ActionIcon variant="subtle" color="gray" size="sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                      <IconChevronUp size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Move down">
                    <ActionIcon
                      variant="subtle"
                      color="gray"
                      size="sm"
                      aria-label="Move down"
                      disabled={i === items.length - 1}
                      onClick={() => move(i, 1)}
                    >
                      <IconChevronDown size={14} />
                    </ActionIcon>
                  </Tooltip>
                  <Tooltip label="Remove">
                    <ActionIcon variant="subtle" color="danger" size="sm" aria-label="Remove" onClick={() => remove(i)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </div>
                <Accordion.Panel>{render(item, (next) => update(i, next))}</Accordion.Panel>
              </Accordion.Item>
            )
          })}
        </Accordion>
      )}
    </div>
  )
}
