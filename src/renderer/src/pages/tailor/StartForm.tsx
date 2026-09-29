import { useState } from 'react'
import {
  Alert,
  Anchor,
  Button,
  Card,
  Group,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  TextInput,
  Textarea,
  Title
} from '@mantine/core'
import type { RunnerEnvironment, StartRunParams } from '@shared/runner-types'
import { useNavigation, type PageParams } from '../../navigation'

interface Props {
  prefill: PageParams['tailor']
  environment: RunnerEnvironment | null
  busy: boolean
  onStart(params: StartRunParams): void
}

/** The job to tailor for: a pasted description and/or a posting URL, plus the skill's options. */
export function StartForm({ prefill, environment, busy, onStart }: Props) {
  const { navigate } = useNavigation()
  const [jobDescription, setJobDescription] = useState(prefill?.jobDescription ?? '')
  const [jobUrl, setJobUrl] = useState(prefill?.jobUrl ?? '')
  const [company, setCompany] = useState(prefill?.company ?? '')
  const [role, setRole] = useState(prefill?.role ?? '')
  const [jobId, setJobId] = useState(prefill?.jobId ?? '')
  const [notes, setNotes] = useState('')
  const [coverLetter, setCoverLetter] = useState(true)
  const [dateStyle, setDateStyle] = useState<'inline' | 'right'>('right')

  const urlOk = !jobUrl.trim() || /^https?:\/\//i.test(jobUrl.trim())
  const canStart = (jobDescription.trim() !== '' || jobUrl.trim() !== '') && urlOk && !busy
  const blocking = environment && (!environment.claudePath || !environment.skillDir)

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>New tailored resume</Title>
          <Text size="sm" c="dimmed">
            Claude runs the resume-tailor skill on your master profile. It stops after the gap analysis to ask you to
            approve the wording, then builds the PDFs into this workspace.
          </Text>
        </div>

        {environment && !environment.ready && (
          <Alert
            color={blocking ? 'red' : 'yellow'}
            variant="light"
            title={blocking ? 'Cannot run yet' : 'Some dependencies are missing'}
          >
            <Text size="sm">{environment.problems[0]}</Text>
            {!blocking && (
              <Text size="sm" mt={4}>
                Claude can still do the gap analysis and write the resume data, but the PDF build will fail.
              </Text>
            )}
            <Anchor component="button" size="sm" mt={4} onClick={() => navigate('settings')}>
              Open Settings
            </Anchor>
          </Alert>
        )}

        <TextInput
          label="Job posting URL"
          placeholder="https://…"
          value={jobUrl}
          onChange={(e) => setJobUrl(e.currentTarget.value)}
          error={urlOk ? undefined : 'Must start with http:// or https://'}
        />
        <Textarea
          label="Job description"
          description="Paste the full posting. Leave empty to let Claude fetch it from the URL; pages that need JavaScript (Ashby, Workday, …) come back empty, so paste those, or add them on the Jobs page, which opens them in a real browser."
          autosize
          minRows={8}
          maxRows={18}
          value={jobDescription}
          onChange={(e) => setJobDescription(e.currentTarget.value)}
        />
        <SimpleGrid cols={3}>
          <TextInput
            label="Company"
            placeholder="optional"
            value={company}
            onChange={(e) => setCompany(e.currentTarget.value)}
          />
          <TextInput
            label="Role"
            placeholder="optional"
            value={role}
            onChange={(e) => setRole(e.currentTarget.value)}
          />
          <TextInput
            label="Job id"
            placeholder="optional"
            value={jobId}
            onChange={(e) => setJobId(e.currentTarget.value)}
          />
        </SimpleGrid>
        <Textarea
          label="Notes for Claude"
          placeholder="Optional: angle, seniority, stack to emphasise…"
          autosize
          minRows={2}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <Group justify="space-between" align="flex-end">
          <Group gap="xl">
            <Switch
              label="Cover letter"
              checked={coverLetter}
              onChange={(e) => setCoverLetter(e.currentTarget.checked)}
            />
            <Stack gap={4}>
              <Text size="sm" fw={500}>
                Date style
              </Text>
              <SegmentedControl
                size="xs"
                value={dateStyle}
                onChange={(v) => setDateStyle(v as 'inline' | 'right')}
                data={[
                  { value: 'right', label: 'Right-aligned (human reader)' },
                  { value: 'inline', label: 'Inline (strict ATS)' }
                ]}
              />
            </Stack>
          </Group>
          <Button
            size="md"
            loading={busy}
            disabled={!canStart || !!blocking}
            onClick={() =>
              onStart({
                jobDescription: jobDescription.trim() || undefined,
                jobUrl: jobUrl.trim() || undefined,
                company: company.trim() || undefined,
                role: role.trim() || undefined,
                jobId: jobId.trim() || undefined,
                notes: notes.trim() || undefined,
                coverLetter,
                dateStyle
              })
            }
          >
            Start tailoring
          </Button>
        </Group>
      </Stack>
    </Card>
  )
}
