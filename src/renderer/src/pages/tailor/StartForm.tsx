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
import { AGENT_LABEL, DEFAULT_AGENT, type AgentId, type RunnerEnvironment, type StartRunParams } from '@shared/runner-types'
import { api, errorText } from '../../api'
import { AgentPicker, agentStatus } from '../../components/AgentPicker'
import { useNavigation, type PageParams } from '../../navigation'

interface Props {
  prefill: PageParams['tailor']
  environment: RunnerEnvironment | null
  busy: boolean
  onStart(params: StartRunParams): void
  /** A fresh environment check after installing something from the form. */
  onEnvironmentChange(environment: RunnerEnvironment): void
}

/** The job to tailor for: a pasted description and/or a posting URL, plus the skill's options. */
export function StartForm({ prefill, environment, busy, onStart, onEnvironmentChange }: Props) {
  const { navigate } = useNavigation()
  const [jobDescription, setJobDescription] = useState(prefill?.jobDescription ?? '')
  const [jobUrl, setJobUrl] = useState(prefill?.jobUrl ?? '')
  const [company, setCompany] = useState(prefill?.company ?? '')
  const [role, setRole] = useState(prefill?.role ?? '')
  const [jobId, setJobId] = useState(prefill?.jobId ?? '')
  const [notes, setNotes] = useState('')
  const [coverLetter, setCoverLetter] = useState(true)
  const [dateStyle, setDateStyle] = useState<'inline' | 'right'>('right')
  /** The user's pick; until then the page's preselection or the default agent (known once the environment loads). */
  const [picked, setPicked] = useState<AgentId | null>(null)
  const agent = picked ?? prefill?.agent ?? environment?.defaultAgent ?? DEFAULT_AGENT
  const agentLabel = AGENT_LABEL[agent]
  const status = agentStatus(environment, agent)

  const urlOk = !jobUrl.trim() || /^https?:\/\//i.test(jobUrl.trim())
  // A job sent from the Jobs page without its full posting: its URL is a job board page or an employer
  // page that already failed to load, so the run needs text, not the URL.
  const needsPaste =
    prefill?.descriptionComplete === false && !jobDescription.trim() && jobUrl.trim() === (prefill.jobUrl ?? '').trim()
  const canStart = (jobDescription.trim() !== '' || jobUrl.trim() !== '') && urlOk && !needsPaste && !busy
  // Once the user edits or pastes the description, it is theirs, not the board's summary.
  const showSummaryNotice =
    prefill?.descriptionComplete === false && (needsPaste || jobDescription === (prefill.jobDescription ?? ''))
  // The chosen agent's CLI or skill is missing: nothing can run. Shared dependencies (LaTeX, venv) only break the build.
  const blocking = !!status && !status.ready
  const problem = blocking ? status.problems[0] : environment?.sharedProblems[0]
  // Claude's copy comes from GitHub; the other agents get a link to it.
  const canInstallSkill =
    !!environment && (agent === 'claude' ? !environment.skillDir : !!environment.skillDir && !status?.skillPath)
  const [installingSkill, setInstallingSkill] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)

  async function installSkill() {
    setInstallingSkill(true)
    setInstallError(null)
    try {
      const res = agent === 'claude' ? await api.runner.installSkill(false) : await api.runner.linkSkill(agent)
      if (!res.ok) setInstallError(res.error ?? 'Installing the skill failed.')
      onEnvironmentChange(await api.runner.environment())
    } catch (err) {
      setInstallError(errorText(err))
    } finally {
      setInstallingSkill(false)
    }
  }

  return (
    <Card withBorder radius="md" padding="lg">
      <Stack gap="md">
        <div>
          <Title order={3}>New tailored resume</Title>
          <Text size="sm" c="dimmed">
            {agentLabel} runs the resume-tailor skill on your master profile. It stops after the gap analysis to ask you to
            approve the wording, then builds the PDFs into this workspace.
          </Text>
        </div>

        {environment && problem && (
          <Alert
            color={blocking ? 'red' : 'yellow'}
            variant="light"
            title={blocking ? `${agentLabel} cannot run yet` : 'Some dependencies are missing'}
          >
            <Text size="sm">{problem}</Text>
            {!blocking && (
              <Text size="sm" mt={4}>
                {agentLabel} can still do the gap analysis and write the resume data, but the PDF build will fail.
              </Text>
            )}
            {installError && (
              <Text size="sm" c="red" mt={4}>
                {installError}
              </Text>
            )}
            <Group gap="md" mt="xs">
              {blocking && canInstallSkill && (
                <Button size="xs" loading={installingSkill} onClick={installSkill}>
                  {agent === 'claude' ? 'Install resume-tailor skill' : `Install skill for ${agentLabel}`}
                </Button>
              )}
              <Anchor component="button" size="sm" onClick={() => navigate('settings')}>
                Open Settings
              </Anchor>
            </Group>
          </Alert>
        )}

        <TextInput
          label="Job posting URL"
          placeholder="https://…"
          value={jobUrl}
          onChange={(e) => setJobUrl(e.currentTarget.value)}
          error={urlOk ? undefined : 'Must start with http:// or https://'}
        />
        {prefill && showSummaryNotice && (
          <Alert
            color={needsPaste ? 'orange' : 'yellow'}
            variant="light"
            title={needsPaste ? 'No job description yet' : "Only the job board's summary"}
          >
            <Text size="sm">
              {needsPaste
                ? 'The job board gave no description for this job. Open the posting and paste its text below to start.'
                : "This is the job board's summary, not the full posting. Paste the full text from the posting below for a better resume; you can still start with the summary."}
            </Text>
            {prefill.jobUrl && (
              <Anchor href={prefill.jobUrl} target="_blank" rel="noreferrer" size="sm" mt={4} display="inline-block">
                Open posting
              </Anchor>
            )}
          </Alert>
        )}
        <Textarea
          label="Job description"
          description="Paste the full posting. Leave it empty only for an employer or ATS page (Greenhouse, Lever, careers sites): Huntgry reads those from the URL. Job boards (Indeed, hiring.cafe) and pages that need JavaScript (Ashby, Workday, …) cannot be read that way: paste those, or send them from the Jobs page."
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
          label={`Notes for ${agentLabel}`}
          placeholder="Optional: angle, seniority, stack to emphasise…"
          autosize
          minRows={2}
          value={notes}
          onChange={(e) => setNotes(e.currentTarget.value)}
        />
        <Group gap="xl" align="flex-end">
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
        <Group justify="space-between" align="flex-end">
          <AgentPicker environment={environment} value={agent} onChange={setPicked} />
          <Button
            size="md"
            loading={busy}
            disabled={!canStart || blocking}
            onClick={() =>
              onStart({
                jobDescription: jobDescription.trim() || undefined,
                jobUrl: jobUrl.trim() || undefined,
                company: company.trim() || undefined,
                role: role.trim() || undefined,
                jobId: jobId.trim() || undefined,
                notes: notes.trim() || undefined,
                coverLetter,
                dateStyle,
                agent,
                // The Jobs page's board applies only while the URL is still that job's; anything else is manual.
                source: jobUrl.trim()
                  ? prefill?.source && jobUrl.trim() === prefill.jobUrl?.trim()
                    ? prefill.source
                    : 'manual'
                  : undefined
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
