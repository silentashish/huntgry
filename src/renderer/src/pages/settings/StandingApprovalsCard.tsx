import { useCallback, useEffect, useState } from 'react'
import { ActionIcon, Alert, Button, Group, Stack, Table, Text, Tooltip } from '@mantine/core'
import { IconAlertTriangle, IconTrash } from '@tabler/icons-react'
import { APPROVALS_PROMPT_CAP, type ApprovalsSummary } from '@shared/review-types'
import { api, errorText } from '../../api'
import { MonoLabel } from '../../components/ui'
import { SettingsCard, TableFrame } from './SettingsCard'

/** The reframings kept on the Review page, which every run gets as preferred wordings (#158); remove any of them here. */
export function StandingApprovalsCard() {
  const [data, setData] = useState<ApprovalsSummary | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)

  const load = useCallback(async () => {
    try {
      setData(await api.review.approvals())
      setError(null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  async function act(call: () => Promise<ApprovalsSummary>) {
    setError(null)
    try {
      setData(await call())
    } catch (err) {
      setError(errorText(err))
    }
  }

  const list = data?.approvals ?? []
  return (
    <SettingsCard
      title="Standing approvals"
      description="Reframings you ticked on the Review page. Every run uses each one as the preferred wording when it uses that fact. Stored with the app's data, outside the workspace, so an agent can never add one."
      actions={
        list.length === 0 ? null : confirmAll ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm">Remove all {list.length}?</Text>
            <Button
              size="xs"
              variant="light"
              color="danger"
              onClick={() => void act(api.review.removeAllApprovals).then(() => setConfirmAll(false))}
            >
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
            {data.leftOut} older approval{data.leftOut === 1 ? ' is' : 's are'} not sent to runs (the prompt
            carries the newest {APPROVALS_PROMPT_CAP.entries}, at most {Math.round(APPROVALS_PROMPT_CAP.bytes / 1024)}{' '}
            KB). Remove ones you no longer stand behind.
          </Alert>
        )}
        {data && list.length === 0 && (
          <Text size="sm" c="dimmed">
            None yet. Tick reframings when you approve a result on the Review page.
          </Text>
        )}
        {list.length > 0 && (
          <TableFrame>
            <Table layout="fixed" horizontalSpacing="md" verticalSpacing={12}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w="30%">Source fact</Table.Th>
                  <Table.Th>Wording</Table.Th>
                  <Table.Th w={150}>Approved</Table.Th>
                  <Table.Th w={56} />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {list.map((a) => (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Text size="sm">{a.sourceFact}</Text>
                      {a.requirement && (
                        <MonoLabel size="xs" component="div">
                          {a.requirement}
                        </MonoLabel>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{a.wording}</Text>
                    </Table.Td>
                    <Table.Td>
                      <MonoLabel tone="secondary" component="div">
                        {new Date(a.approvedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                      </MonoLabel>
                      <MonoLabel size="xs" component="div" title={a.applicationId}>
                        <Text span inherit truncate display="block">
                          {a.applicationId}
                        </Text>
                      </MonoLabel>
                    </Table.Td>
                    <Table.Td>
                      <Tooltip label="Remove">
                        <ActionIcon
                          variant="subtle"
                          color="red"
                          aria-label="Remove approval"
                          onClick={() => void act(() => api.review.removeApproval(a.id))}
                        >
                          <IconTrash size={14} />
                        </ActionIcon>
                      </Tooltip>
                    </Table.Td>
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
