import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { Alert, Anchor, NativeSelect, TextInput } from '@mantine/core'
import { displayAnswer, FACT_KEYS, FACTS, type FactKey } from '@shared/apply-facts'
import type { SavedAnswers } from '@shared/apply-types'
import { api, errorText } from '../../api'
import classes from './editor.module.css'
import { SectionHead } from './fields'

/**
 * Profile → Application details (#136): the one-time answers application
 * forms ask for (work authorization, sponsorship, notice period, EEO…), set up
 * front so autofill can answer them. They are the answers memory of #71, not
 * part of master-profile.md: main stores them under userData, outside the
 * workspace, and sensitive ones never reach a model. Each change is saved at
 * once (yes/no on change, text on blur or after a short pause).
 */

export interface FactGroup {
  title: string
  facts: FactKey[]
  /** A muted line under the title. */
  note?: string
}

export const SENSITIVE_NOTE =
  'Stored on this computer only, outside your workspace; never sent to the AI model. Leave blank to be asked once per application.'

/** Every catalog fact, once, in the order the Profile shows them. */
export const FACT_GROUPS: FactGroup[] = [
  { title: 'Work eligibility', facts: ['visaStatus', 'workAuthorized', 'needsSponsorship', 'securityClearance'] },
  { title: 'Availability & pay', facts: ['earliestStart', 'noticePeriod', 'salaryExpectation', 'willingToRelocate', 'over18'] },
  {
    title: 'About you',
    facts: ['yearsExperience', 'highestEducation', 'previouslyEmployed', 'relativeEmployed', 'howHeard', 'currentCity']
  },
  {
    title: 'Voluntary self-identification',
    facts: ['pronouns', 'gender', 'hispanicLatino', 'raceEthnicity', 'veteranStatus', 'disabilityStatus'],
    note: SENSITIVE_NOTE
  }
]

/** Suggested values for the facts answered from a list on most forms (typed text is still accepted). */
export const FACT_SUGGESTIONS: Partial<Record<FactKey, string[]>> = {
  visaStatus: ['US citizen', 'Permanent resident', 'H-1B', 'F-1 OPT', 'F-1 STEM OPT', 'TN', 'L-1', 'E-3', 'O-1', 'EAD', 'Other'],
  gender: ['Male', 'Female', 'Non-binary', 'Decline to self-identify'],
  // The EEO-1 categories.
  raceEthnicity: [
    'Hispanic or Latino',
    'White',
    'Black or African American',
    'Asian',
    'Native Hawaiian or Other Pacific Islander',
    'American Indian or Alaska Native',
    'Two or More Races',
    'Decline to self-identify'
  ],
  pronouns: ['He/him', 'She/her', 'They/them']
}

const PLACEHOLDERS: Partial<Record<FactKey, string>> = {
  earliestStart: 'e.g. Two weeks after an offer',
  noticePeriod: 'e.g. 2 weeks',
  salaryExpectation: 'e.g. $150,000',
  yearsExperience: 'e.g. 6',
  highestEducation: "e.g. Bachelor's degree",
  howHeard: 'e.g. LinkedIn',
  currentCity: 'e.g. Portland, OR'
}

/** How long a typed answer waits before it is saved (blur saves at once). */
export const SAVE_DELAY_MS = 400

type Status = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string }

/** A stored value as its control shows it: yes/no facts use the select's values, choices show "Decline to self-identify". */
function shown(fact: FactKey, value: string): string {
  if (FACTS[fact].kind === 'yesno' || FACTS[fact].kind === 'text') return value
  return displayAnswer(value)
}

/**
 * One fact's control: a native select for yes/no facts (Yes / No / Prefer not
 * to say; empty = not set), a text input otherwise, with suggestions for the
 * list-like ones. `seed` is what the master profile states when nothing is
 * stored, shown as a placeholder.
 */
export function FactControl({
  fact,
  value,
  seed,
  onSave,
  label = FACTS[fact].label,
  labelHidden = false,
  className,
  style
}: {
  fact: FactKey
  /** The stored value ('' when not set). */
  value: string
  seed?: string
  /** Saves the value ('' forgets); rejects with the reason shown under the control. */
  onSave(fact: FactKey, value: string): Promise<void>
  label?: string
  /** In a table row the question is in its own cell: the label is only announced. */
  labelHidden?: boolean
  className?: string
  style?: CSSProperties
}) {
  const info = FACTS[fact]
  const listId = useId()
  const [text, setText] = useState(() => shown(fact, value))
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const focused = useRef(false)
  const lastSaved = useRef(shown(fact, value))

  // Adopt outside changes (another save, Forget all) unless the user is typing here.
  useEffect(() => {
    lastSaved.current = shown(fact, value)
    if (!focused.current && timer.current === null) setText(shown(fact, value))
  }, [fact, value])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const save = useCallback(
    async (next: string) => {
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (next.trim() === lastSaved.current.trim()) return
      setStatus({ kind: 'saving' })
      try {
        await onSave(fact, next)
        lastSaved.current = next
        setStatus({ kind: 'saved' })
      } catch (err) {
        setStatus({ kind: 'error', message: errorText(err) })
      }
    },
    [fact, onSave]
  )

  const description = status.kind === 'saving' ? 'Saving…' : status.kind === 'saved' ? 'Saved' : undefined
  const error = status.kind === 'error' ? status.message : undefined
  const fromProfile = seed ? `From your profile: ${displayAnswer(seed)}` : undefined
  const labelProps = labelHidden ? { 'aria-label': label } : { label }

  if (info.kind === 'yesno') {
    return (
      <NativeSelect
        {...labelProps}
        className={className}
        style={style}
        inputWrapperOrder={['label', 'input', 'description', 'error']}
        description={description}
        error={error}
        value={text}
        data={[
          { value: '', label: fromProfile ?? 'Not set' },
          { value: 'yes', label: 'Yes' },
          { value: 'no', label: 'No' },
          { value: 'decline', label: 'Prefer not to say' }
        ]}
        onChange={(e) => {
          const next = e.currentTarget.value
          setText(next)
          void save(next)
        }}
      />
    )
  }

  const suggestions = FACT_SUGGESTIONS[fact]
  return (
    <>
      <TextInput
        {...labelProps}
        className={className}
        style={style}
        inputWrapperOrder={['label', 'input', 'description', 'error']}
        description={description}
        error={error}
        placeholder={fromProfile ?? PLACEHOLDERS[fact] ?? (suggestions ? `e.g. ${suggestions[0]}` : undefined)}
        maxLength={500}
        list={suggestions ? listId : undefined}
        autoComplete="off"
        value={text}
        onFocus={() => {
          focused.current = true
        }}
        onChange={(e) => {
          const next = e.currentTarget.value
          setText(next)
          if (timer.current) clearTimeout(timer.current)
          timer.current = setTimeout(() => {
            timer.current = null
            void save(next)
          }, SAVE_DELAY_MS)
        }}
        onBlur={(e) => {
          focused.current = false
          void save(e.currentTarget.value)
        }}
      />
      {suggestions && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </>
  )
}

/** The stored value of each fact ('' when not set). */
export function factValues(data: SavedAnswers | null): Partial<Record<FactKey, string>> {
  return Object.fromEntries((data?.facts ?? []).map((f) => [f.fact, f.value]))
}

/** The Profile page's Application details section: every fact of the catalog, grouped, saved as it changes. */
export function ApplicationDetails({ onOpenSettings }: { onOpenSettings?(): void }) {
  const [data, setData] = useState<SavedAnswers | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.apply.answers().then(
      (d) => alive && setData(d),
      (err: unknown) => alive && setError(errorText(err))
    )
    return () => {
      alive = false
    }
  }, [])

  const onSave = useCallback(async (fact: FactKey, value: string) => {
    setData(await api.apply.setFact(fact, value))
  }, [])

  const values = factValues(data)
  const seeds = data?.seeds ?? {}
  const set = FACT_KEYS.filter((k) => values[k]).length

  return (
    <div className={classes.section}>
      <SectionHead
        title="Application details"
        meta={`${set} of ${FACT_KEYS.length} set · answers autofill gives on application forms; not written to master-profile.md`}
      />
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      <p className={classes.hint}>
        Saved as you change them, with the answers you told Apply to remember
        {onOpenSettings ? (
          <>
            {' '}
            (also in{' '}
            <Anchor component="button" type="button" size="xs" onClick={onOpenSettings}>
              Settings → Saved application answers
            </Anchor>
            )
          </>
        ) : null}
        . Your Work authorization line fills the eligibility answers until you set them here.
      </p>
      {FACT_GROUPS.map((group) => (
        <section key={group.title} className={classes.section} aria-label={group.title}>
          <SectionHead title={group.title} meta={group.note} order={4} />
          <div className={classes.card}>
            <div className={classes.fieldGrid}>
              {data &&
                group.facts.map((fact) => (
                  <FactControl
                    key={fact}
                    fact={fact}
                    value={values[fact] ?? ''}
                    seed={values[fact] ? undefined : seeds[fact]}
                    onSave={onSave}
                    className={classes.field}
                    style={{ '--field-cols': 6 } as CSSProperties}
                  />
                ))}
            </div>
          </div>
        </section>
      ))}
    </div>
  )
}
