import { Alert, Badge, Card, Code, Group, List, Stack, Text } from '@mantine/core'
import type { WorkspaceInspection, WorkspaceStatus as Status } from '@shared/workspace-types'

const STATUS_META: Record<Status, { color: string; label: string; hint: string }> = {
  valid: { color: 'green', label: 'valid', hint: 'Ready for the resume-tailor skill.' },
  legacy: { color: 'yellow', label: 'legacy', hint: 'Older Resume Tailor layout. Usable as is.' },
  empty: { color: 'blue', label: 'empty', hint: 'Empty folder. Create a new workspace here.' },
  missing: { color: 'blue', label: 'missing', hint: 'Folder does not exist yet. Create will make it.' },
  'not-a-workspace': {
    color: 'orange',
    label: 'not-a-workspace',
    hint: 'Folder has unrelated content. Pick an empty folder or an existing workspace.'
  },
  invalid: { color: 'red', label: 'invalid', hint: 'This path cannot be used.' }
}

export function WorkspaceStatus({ inspection }: { inspection: WorkspaceInspection }) {
  const meta = STATUS_META[inspection.status]
  return (
    <Card withBorder radius="md" padding="lg" aria-live="polite">
      <Stack gap="sm">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600}>Workspace</Text>
          <Badge color={meta.color} variant="light" size="lg">
            {meta.label}
          </Badge>
        </Group>
        <Code block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {inspection.path}
        </Code>
        <Text size="sm" c="dimmed">
          {meta.hint}
        </Text>
        <Group gap="xl">
          <Text size="sm">
            Master profile: <Code>{inspection.masterProfile ?? 'none'}</Code>
          </Text>
          <Text size="sm">
            Applications: <Code>{inspection.applicationCount}</Code>
          </Text>
        </Group>
        {inspection.errors.length > 0 && (
          <Alert color="red" title="Problems" variant="light">
            <List size="sm">
              {inspection.errors.map((e) => (
                <List.Item key={e}>{e}</List.Item>
              ))}
            </List>
          </Alert>
        )}
        {inspection.warnings.length > 0 && (
          <Alert color="yellow" title="Warnings" variant="light">
            <List size="sm">
              {inspection.warnings.map((w) => (
                <List.Item key={w}>{w}</List.Item>
              ))}
            </List>
          </Alert>
        )}
      </Stack>
    </Card>
  )
}
