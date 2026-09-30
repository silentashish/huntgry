import { useCallback, useEffect, useState } from 'react'
import { ActionIcon, Alert, Button, Card, Group, Table, Text, Title, Tooltip } from '@mantine/core'
import { IconTrash } from '@tabler/icons-react'
import { APPROVALS_PROMPT_CAP, type ApprovalsSummary } from '@shared/review-types'
import { api, errorText } from '../../api'

/** The reframings approved on the Review page, which unattended runs may reuse; remove any of them here. */
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
    <Card withBorder radius="md" padding="lg">
      <Group justify="space-between" align="flex-start" mb="xs">
        <div>
          <Title order={4}>Standing approvals</Title>
          <Text size="sm" c="dimmed">
            Reframings you approved on the Review page. Unattended runs may use each one as written (same fact, same
            wording) without asking. Stored in <code>.huntgry/approved-reframings.json</code> of the workspace.
          </Text>
        </div>
        {list.length > 0 &&
          (confirmAll ? (
            <Group gap="xs">
              <Text size="sm">Remove all {list.length}?</Text>
              <Button size="xs" color="red" onClick={() => void act(api.review.removeAllApprovals).then(() => setConfirmAll(false))}>
                Remove all
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmAll(false)}>
                Keep
              </Button>
            </Group>
          ) : (
            <Button size="xs" variant="light" color="red" onClick={() => setConfirmAll(true)}>
              Remove all
            </Button>
          ))}
      </Group>
      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)} mb="xs">
          {error}
        </Alert>
      )}
      {data && data.leftOut > 0 && (
        <Alert color="yellow" variant="light" py={6} mb="xs">
          <Text size="sm">
            {data.leftOut} older approval{data.leftOut === 1 ? ' is' : 's are'} not sent to unattended runs (the prompt
            carries the newest {APPROVALS_PROMPT_CAP.entries}, at most {Math.round(APPROVALS_PROMPT_CAP.bytes / 1024)} KB).
          </Text>
        </Alert>
      )}
      {data && list.length === 0 && (
        <Text size="sm" c="dimmed">
          None yet. Tick reframings when you approve a result on the Review page.
        </Text>
      )}
      {list.length > 0 && (
        <Table layout="fixed" verticalSpacing="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Source fact</Table.Th>
              <Table.Th>Wording</Table.Th>
              <Table.Th w={170}>Approved</Table.Th>
              <Table.Th w={40} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {list.map((a) => (
              <Table.Tr key={a.id}>
                <Table.Td>
                  <Text size="sm">{a.sourceFact}</Text>
                  {a.requirement && (
                    <Text size="xs" c="dimmed">
                      {a.requirement}
                    </Text>
                  )}
                </Table.Td>
                <Table.Td>
                  <Text size="sm" fw={500}>
                    {a.wording}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs" c="dimmed">
                    {new Date(a.approvedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                  </Text>
                  <Text size="xs" c="dimmed" ff="monospace" truncate>
                    {a.applicationId}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Tooltip label="Remove">
                    <ActionIcon variant="subtle" color="red" aria-label="Remove approval" onClick={() => void act(() => api.review.removeApproval(a.id))}>
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Tooltip>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  )
}
