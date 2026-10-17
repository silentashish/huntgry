import { useState } from 'react'
import { Button, Checkbox, Group, NativeSelect, Textarea } from '@mantine/core'
import type { FieldReport } from '@shared/apply-types'
import { api, errorText } from '../../api'
import { answerChoices, isAiAnswer, isSensitive } from './apply-report'
import classes from './browser.module.css'

/**
 * Answers one question of the page from the Apply panel (#71), the "answer
 * once" box of the design: one of the page's own options (a native select,
 * so nothing pops over the page view) or typed text, with "Remember" on by
 * default. An AI answer (#136) gets the same box as "Correct", pre-filled with
 * what Huntgry wrote; the correction replaces it in the page and in memory. Main checks the answer against the field and fills it in the page;
 * a widget that only takes a click is picked when the Settings switch allows
 * it, otherwise suggested there.
 */
export function AnswerControl({ sessionId, field, disabled }: { sessionId: string; field: FieldReport; disabled: boolean }) {
  const choices = answerChoices(field)
  // An AI answer (#136) is corrected from what Huntgry wrote; a suggestion starts from the suggestion.
  const ai = isAiAnswer(field)
  const start = ai ? field.value : field.suggestion
  const initial = start && (choices.length === 0 || choices.includes(start)) ? start : ''
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(initial)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = field.label || 'this question'
  const verb = ai ? 'Correct' : field.suggestedBy === 'model' ? 'Confirm answer' : 'Answer'

  if (!open) {
    return (
      <Button
        className={classes.answerToggle}
        size="compact-xs"
        variant="default"
        disabled={disabled}
        onClick={() => setOpen(true)}
        aria-label={`${ai ? 'Correct' : 'Answer'} ${name}`}
      >
        {verb}
      </Button>
    )
  }

  async function submit() {
    setError(null)
    setBusy(true)
    try {
      await api.apply.answer(sessionId, field.fieldId!, value, remember)
      setOpen(false)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={classes.answer}>
      <p className={classes.answerTitle}>
        {verb} · {name}
      </p>
      {choices.length > 0 ? (
        <NativeSelect
          aria-label={`Answer for ${name}`}
          data={[{ value: '', label: 'Choose…' }, ...choices]}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
      ) : (
        <Textarea
          autosize
          minRows={1}
          maxRows={4}
          maxLength={500}
          aria-label={`Answer for ${name}`}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
      )}
      <Checkbox
        size="xs"
        label="Remember for next applications"
        checked={remember}
        onChange={(e) => setRemember(e.currentTarget.checked)}
      />
      {isSensitive(field) && (
        <p className={classes.answerNote}>Stored on this computer only, outside your workspace; never sent to the AI model.</p>
      )}
      {error && <p className={classes.answerError}>{error}</p>}
      <Group gap={6}>
        <Button size="xs" loading={busy} disabled={!value.trim() || disabled} onClick={() => void submit()}>
          Use
        </Button>
        <Button size="xs" variant="subtle" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Group>
    </div>
  )
}
