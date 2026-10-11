import { useCallback, useEffect, useState } from 'react'
import { ActionIcon, Alert, Button, Group, Stack, Switch, Table, Text, Tooltip } from '@mantine/core'
import { IconEye, IconTrash } from '@tabler/icons-react'
import { displayAnswer } from '@shared/apply-facts'
import type { SavedAnswers } from '@shared/apply-types'
import { api, errorText } from '../../api'
import { SettingsCard, TableFrame } from './SettingsCard'
import classes from './settings.module.css'

/**
 * The application answers autofill remembers (#71): facts (sensitive ones
 * masked until shown) and questions answered directly. Forget one or all;
 * they are removed from disk.
 */
export function SavedAnswersCard() {
  const [data, setData] = useState<SavedAnswers | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<Set<string>>(new Set())
  const [confirmAll, setConfirmAll] = useState(false)
  const [pick, setPick] = useState<boolean | null>(null)

  const load = useCallback(async () => {
    try {
      setData(await api.apply.answers())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
    api.apply.pickSetting().then(setPick, (err: unknown) => setError(errorText(err)))
  }, [load])

  async function togglePick(on: boolean) {
    setError(null)
    try {
      setPick(await api.apply.setPickSetting(on))
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function act(call: () => Promise<SavedAnswers>) {
    setError(null)
    try {
      setData(await call())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const facts = data?.facts ?? []
  const questions = data?.questions ?? []
  const count = facts.length + questions.length
  const forget = (label: string, call: () => Promise<SavedAnswers>) => (
    <Tooltip label="Forget">
      <ActionIcon variant="subtle" color="red" aria-label={`Forget ${label}`} onClick={() => void act(call)}>
        <IconTrash size={14} />
      </ActionIcon>
    </Tooltip>
  )

  return (
    <SettingsCard
      title="Saved application answers"
      description="Answers you told Apply to remember (authorization, notice period, EEO…). They fill the same questions on later applications. Stored with the app's data on this computer, outside the workspace; agents and AI models never see them."
      actions={
        count === 0 ? null : confirmAll ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">Forget all {count}?</Text>
            <Button
              size="xs"
              variant="light"
              color="danger"
              onClick={() => void act(api.apply.forgetAllAnswers).then(() => setConfirmAll(false))}
            >
              Forget all
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setConfirmAll(false)}>
              Keep
            </Button>
          </Group>
        ) : (
          <Button size="xs" variant="subtle" leftSection={<IconTrash size={14} />} onClick={() => setConfirmAll(true)}>
            Forget all
          </Button>
        )
      }
    >
      <Stack>
        <div className={classes.toggleStrip}>
          <Switch
            label="Pick dropdown answers automatically"
            description="Choose saved answers in dropdowns and Yes/No buttons (Greenhouse, Ashby, Workday) for you. Only answers you confirmed; never Submit, Next or a consent box. Off: they are only suggested in the Apply panel."
            checked={pick ?? true}
            disabled={pick === null}
            onChange={(e) => void togglePick(e.currentTarget.checked)}
          />
        </div>
        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {data && count === 0 && (
          <Text size="sm" c="dimmed">
            None yet. Answer a question in the Apply panel with &quot;Remember&quot; ticked.
          </Text>
        )}
        {count > 0 && (
          <TableFrame>
            <Table layout="fixed" horizontalSpacing="md" verticalSpacing={12} aria-label="Saved application answers">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Question</Table.Th>
                  <Table.Th w="34%">Answer</Table.Th>
                  <Table.Th w={56} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {facts.map((f) => {
                  const masked = f.sensitive && !shown.has(f.fact)
                  return (
                    <Table.Tr key={f.fact}>
                      <Table.Td>
                        <Text size="sm">{f.label}</Text>
                      </Table.Td>
                      <Table.Td>
                        {masked ? (
                          <Group gap={4} wrap="nowrap">
                            <Text size="sm" ff="monospace" c="dimmed">
                              ••••••
                            </Text>
                            <Tooltip label="Show">
                              <ActionIcon
                                size="sm"
                                variant="subtle"
                                color="gray"
                                aria-label={`Show ${f.label}`}
                                onClick={() => setShown((s) => new Set(s).add(f.fact))}
                              >
                                <IconEye size={14} />
                              </ActionIcon>
                            </Tooltip>
                          </Group>
                        ) : (
                          <Text size="sm">{displayAnswer(f.value)}</Text>
                        )}
                      </Table.Td>
                      <Table.Td>{forget(f.label, () => api.apply.forgetAnswer({ fact: f.fact }))}</Table.Td>
                    </Table.Tr>
                  )
                })}
                {questions.map((q) => (
                  <Table.Tr key={q.question}>
                    <Table.Td>
                      <Text size="sm" lineClamp={2}>
                        {q.label}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" lineClamp={2}>
                        {q.value}
                      </Text>
                    </Table.Td>
                    <Table.Td>{forget(q.label, () => api.apply.forgetAnswer({ question: q.question }))}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </TableFrame>
        )}
      </Stack>
    </SettingsCard>
  )
}
