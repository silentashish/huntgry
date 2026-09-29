import type { ReactNode } from 'react'
import { Card, Stack, Text, Title } from '@mantine/core'

/** Header + "coming next" card for pages whose feature has not landed yet. */
export function PagePlaceholder({ title, description, children }: { title: string; description: string; children?: ReactNode }) {
  return (
    <Stack gap="md">
      <Title order={2}>{title}</Title>
      <Card withBorder radius="md" padding="lg">
        <Text c="dimmed">{description}</Text>
        {children}
      </Card>
    </Stack>
  )
}
