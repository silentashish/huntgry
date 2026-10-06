import { useState } from 'react'
import { Button, Checkbox, Group, NativeSelect, Stack, Text, Textarea } from '@mantine/core'
import type { FieldReport } from '@shared/apply-types'
import { api, errorText } from '../../api'
import { answerChoices, isSensitive } from './apply-report'

/**
 * Answers one question of the page from the Apply panel (#71): one of the
 * page's own options (a native select, so nothing pops over the page view) or
 * typed text, with "Remember" on by default. Main checks the answer against
 * the field and fills it in the page; a widget that only takes a click is
 * picked when the Settings switch allows it, otherwise suggested there.
 */
export function AnswerControl({ sessionId, field, disabled }: { sessionId: string; field: FieldReport; disabled: boolean }) {
  const choices = answerChoices(field)
  const initial = field.suggestion && (choices.length === 0 || choices.includes(field.suggestion)) ? field.suggestion : ''
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(initial)
  const [remember, setRemember] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const name = field.label || 'this question'

  if (!open) {
    return (
      <Button size="compact-xs" variant="subtle" px={4} disabled={disabled} onClick={() => setOpen(true)} aria-label={`Answer ${name}`}>
        {field.suggestedBy === 'model' ? 'Confirm answer' : 'Answer'}
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
    <Stack gap={4} mt={4}>
      {choices.length > 0 ? (
        <NativeSelect
          size="xs"
          aria-label={`Answer for ${name}`}
          data={[{ value: '', label: 'Choose…' }, ...choices]}
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
        />
      ) : (
        <Textarea
          size="xs"
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
        <Text size="xs" c="dimmed">
          Stored on this computer only, outside your workspace; never sent to the AI model.
        </Text>
      )}
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
      <Group gap={6}>
        <Button size="compact-xs" loading={busy} disabled={!value.trim() || disabled} onClick={() => void submit()}>
          Use
        </Button>
        <Button size="compact-xs" variant="subtle" color="gray" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </Group>
    </Stack>
  )
}
