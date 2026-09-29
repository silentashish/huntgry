import { useState } from 'react'
import { Alert, Button, Card, Code, SimpleGrid, Stack, Text, Title } from '@mantine/core'
import type { MasterProfile } from '@shared/master-profile'
import { api, errorText } from '../api'

interface Props {
  workspacePath: string
  onImported(draft: { profile: MasterProfile; fileName: string; warnings: string[] }): void
  onManual(): void
}

/** Step after Create: seed the empty master profile from a resume, or fill it by hand. */
export function ProfileSetup({ workspacePath, onImported, onManual }: Props) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function importResume() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.profile.importResume()
      if (result.ok) onImported(result)
      else if (!result.cancelled) setError(result.error ?? 'Could not read the resume.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack gap="lg">
      <div>
        <Title order={3}>Set up your master profile</Title>
        <Text c="dimmed" size="sm" mt={4}>
          The workspace is ready, with an empty <Code>master-profile.md</Code> in
        </Text>
        <Code block mt={6} style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
          {workspacePath}
        </Code>
      </div>

      {error && (
        <Alert color="red" variant="light" role="status">
          {error}
        </Alert>
      )}

      <SimpleGrid cols={{ base: 1, sm: 2 }}>
        <Card withBorder radius="md" padding="lg">
          <Stack gap="sm" h="100%">
            <Title order={4}>Import from a resume</Title>
            <Text size="sm" c="dimmed" style={{ flex: 1 }}>
              Pick your current resume (.docx, .pdf, .txt or .md). Huntgry reads it on this computer, fills in the
              form, and lets you review everything before saving.
            </Text>
            <Button loading={busy} onClick={importResume}>
              Choose resume file…
            </Button>
          </Stack>
        </Card>
        <Card withBorder radius="md" padding="lg">
          <Stack gap="sm" h="100%">
            <Title order={4}>Fill it in manually</Title>
            <Text size="sm" c="dimmed" style={{ flex: 1 }}>
              Start from an empty form: contact details, summary, skills, experience, projects, education,
              certifications and publications. You can import a resume later too.
            </Text>
            <Button variant="default" disabled={busy} onClick={onManual}>
              Start with an empty form
            </Button>
          </Stack>
        </Card>
      </SimpleGrid>

      <Text size="xs" c="dimmed">
        The profile is a plain Markdown file. You can also edit it in any text editor; Huntgry reads it again every time
        it opens.
      </Text>
    </Stack>
  )
}
