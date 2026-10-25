import { useCallback, useEffect, useState } from 'react'
import { ActionIcon, Alert, Button, Group, Stack, Table, Text, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconTrash } from '@tabler/icons-react'
import { RULES_PROMPT_CAP, type ReframingRule, type ReframingRulesSummary } from '@shared/review-types'
import { api, errorText } from '../../api'
import { MonoLabel, StatusPill } from '../../components/ui'
import { SettingsCard, TableFrame } from './SettingsCard'

/**
 * The reframing rules (#159): the wordings kept on the Review page (preferred, the standing
 * approvals of #31 and #158) and the ones rejected there (with the better wording, if any), which
 * every run gets as caller rules. Remove any of them here.
 */
export function ReframingRulesCard() {
  const [data, setData] = useState<ReframingRulesSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.review.rules())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function act(call: () => Promise<ReframingRulesSummary>) {
    setError(null)
    try {
      setData(await call())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const list = data?.rules ?? []
  const preferred = list.filter((r) => r.kind === 'preferred')
  const rejected = list.filter((r) => r.kind === 'rejected')
  const remove = (id: string) => void act(() => api.review.removeRule(id))
  return (
    <SettingsCard
      title="Reframing rules"
      description="Your decisions on the Review page. Every run uses a preferred wording as written when it uses that fact, and never uses a rejected wording (or a close paraphrase) for its fact. Stored with the app's data, outside the workspace, so an agent can never add one."
      actions={
        list.length === 0 ? null : confirmAll ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">Remove all {list.length}?</Text>
            <Button size="xs" variant="light" color="danger" onClick={() => void act(api.review.removeAllRules).then(() => setConfirmAll(false))}>
              Remove all
            </Button>
            <Button size="xs" variant="subtle" onClick={() => setConfirmAll(false)}>
              Keep
            </Button>
          </Group>
        ) : (
          <Button size="xs" variant="subtle" leftSection={<IconTrash size={14} />} onClick={() => setConfirmAll(true)}>
            Remove all
          </Button>
        )
      }
    >
      <Stack>
        {error && (
          <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
            {error}
          </Alert>
        )}
        {data && data.leftOut > 0 && (
          <Alert color="yellow" variant="light" icon={<IconAlertTriangle size={18} />}>
            {data.leftOut} older rule{data.leftOut === 1 ? ' is' : 's are'} not sent to runs (the prompt carries the newest{' '}
            {RULES_PROMPT_CAP.entries} wordings, at most {Math.round(RULES_PROMPT_CAP.bytes / 1024)} KB). Remove ones you no longer stand behind.
          </Alert>
        )}
        {data && list.length === 0 && (
          <Text size="sm" c="dimmed">
            None yet. On the Review page, tick a reframing to keep its wording or reject one you do not want.
          </Text>
        )}
        {preferred.length > 0 && <RulesTable title="Preferred wordings" rules={preferred} onRemove={remove} />}
        {rejected.length > 0 && <RulesTable title="Rejected wordings" rules={rejected} onRemove={remove} />}
      </Stack>
    </SettingsCard>
  )
}

function RulesTable({ title, rules, onRemove }: { title: string; rules: ReframingRule[]; onRemove(id: string): void }) {
  const rejected = rules[0]?.kind === 'rejected'
  return (
    <section aria-label={title}>
      <Group gap="xs" mb={6}>
        <Text size="sm" fw={600}>
          {title}
        </Text>
        <StatusPill tone={rejected ? 'danger' : 'success'} variant="outline">
          {rules.length}
        </StatusPill>
      </Group>
      <TableFrame>
        <Table layout="fixed" horizontalSpacing="md" verticalSpacing={12}>
          <Table.Thead>
            <Table.Tr>
              <Table.Th w="30%">Source fact</Table.Th>
              <Table.Th>{rejected ? 'Rejected wording' : 'Wording'}</Table.Th>
              <Table.Th w={150}>{rejected ? 'Rejected' : 'Kept'}</Table.Th>
              <Table.Th w={56} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {rules.map((r) => (
              <Table.Tr key={r.id}>
                <Table.Td>
                  <Text size="sm">{r.sourceFact}</Text>
                  {r.requirement && (
                    <MonoLabel size="xs" component="div">
                      {r.requirement}
                    </MonoLabel>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" td={rejected ? 'line-through' : undefined}>
                    {r.wording}
                  </Text>
                  {r.betterWording && (
                    <Text size="sm" mt={4}>
                      <MonoLabel size="xs">Use instead</MonoLabel> {r.betterWording}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <MonoLabel tone="secondary" component="div">
                    {new Date(r.at).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                  </MonoLabel>
                  <MonoLabel size="xs" component="div" title={r.applicationId}>
                    <Text span inherit truncate display="block">
                      {r.applicationId}
                    </Text>
                  </MonoLabel>
                </Table.Td>
                <Table.Td>
                  <Tooltip label="Remove">
                    <ActionIcon variant="subtle" color="red" aria-label={`Remove rule: ${r.wording}`} onClick={() => onRemove(r.id)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </TableFrame>
    </section>
  )
}
