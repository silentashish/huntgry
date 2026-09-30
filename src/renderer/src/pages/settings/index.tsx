import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Alert,
  Badge,
  Button,
  Card,
  Code,
  Group,
  List,
  Loader,
  ScrollArea,
  Stack,
  Table,
  Text,
  Title
} from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconRefresh, IconX } from '@tabler/icons-react'
import { CLAUDE_COMMANDS, type InstallResult, type PreflightItem, type RunnerEnvironment } from '@shared/runner-types'
import { api, errorText } from '../../api'

const STATUS: Record<PreflightItem['status'], { color: string; label: string }> = {
  ok: { color: 'green', label: 'OK' },
  missing: { color: 'red', label: 'Missing' },
  optional: { color: 'gray', label: 'Optional' }
}

const INSTALL_KIND_LABEL = { native: 'native install', homebrew: 'Homebrew', npm: 'npm', other: '' } as const

type Installer = 'python' | 'claude' | 'update' | 'skill' | 'reinstall-skill'

/** Where the Claude CLI and the resume-tailor skill are, and whether their dependencies are installed. */
export function SettingsPage() {
  const [env, setEnv] = useState<RunnerEnvironment | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Installer | null>(null)
  const [log, setLog] = useState<string[]>([])
  const logEnd = useRef<HTMLDivElement>(null)

  const check = useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      setEnv(await api.runner.environment())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void check()
  }, [check])

  useEffect(() => api.on('runner:install-log', (line) => setLog((l) => [...l.slice(-400), line])), [])
  useEffect(() => {
    void logEnd.current?.scrollIntoView({ block: 'end' })
  }, [log])

  async function install(which: Installer, job: () => Promise<InstallResult>, failure: string) {
    setInstalling(which)
    setLog([])
    try {
      const res = await job()
      if (!res.ok) setError(res.error ?? failure)
      await check()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setInstalling(null)
    }
  }

  const installPython = () =>
    install('python', () => api.runner.installPythonDeps(), 'Installing Python dependencies failed.')
  const installClaude = () => install('claude', () => api.runner.installClaude(), 'Installing Claude Code failed.')
  const updateClaude = () => install('update', () => api.runner.updateClaude(), 'Updating Claude Code failed.')
  const installSkill = (replace: boolean) =>
    install(
      replace ? 'reinstall-skill' : 'skill',
      () => api.runner.installSkill(replace),
      'Installing the resume-tailor skill failed.'
    )

  return (
    <Stack gap="md">
      <Group justify="space-between">
        <Title order={2}>Settings</Title>
        <Button variant="default" leftSection={<IconRefresh size={16} />} loading={checking} onClick={check}>
          Check again
        </Button>
      </Group>

      {error && (
        <Alert color="red" variant="light" withCloseButton onClose={() => setError(null)}>
          {error}
        </Alert>
      )}

      {!env && checking && (
        <Group>
          <Loader size="sm" />
          <Text c="dimmed">Looking for Claude, the skill and its dependencies…</Text>
        </Group>
      )}

      {env && (
        <>
          {env.ready ? (
            <Alert color="green" variant="light" icon={<IconCheck size={18} />} title="Ready to tailor">
              Claude, the resume-tailor skill and every dependency it needs to build PDFs are installed.
            </Alert>
          ) : (
            <Alert color="yellow" variant="light" title="Not everything is in place">
              <List size="sm">
                {env.problems.map((p) => (
                  <List.Item key={p}>{p}</List.Item>
                ))}
              </List>
            </Alert>
          )}

          {env.warnings.length > 0 && (
            <Alert color="orange" variant="light" icon={<IconAlertTriangle size={18} />}>
              <List size="sm">
                {env.warnings.map((w) => (
                  <List.Item key={w}>{w}</List.Item>
                ))}
              </List>
            </Alert>
          )}

          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="sm">
              Claude
            </Title>
            <Table layout="fixed">
              <Table.Tbody>
                <Row
                  label="Claude CLI"
                  value={env.claudePath}
                  badges={[
                    {
                      text: env.claudeVersion ?? 'version unknown',
                      color: env.claudeVersionOk ? 'gray' : 'red'
                    },
                    ...(env.claudeInstallKind && INSTALL_KIND_LABEL[env.claudeInstallKind]
                      ? [{ text: INSTALL_KIND_LABEL[env.claudeInstallKind], color: 'gray' }]
                      : [])
                  ]}
                  missing={
                    <Stack gap={4} align="flex-start">
                      <Button size="xs" loading={installing === 'claude'} disabled={!!installing} onClick={installClaude}>
                        Install Claude Code
                      </Button>
                      <Text size="xs" c="dimmed">
                        Runs the official installer. Or in a terminal: <Code>{CLAUDE_COMMANDS.install}</Code>
                      </Text>
                    </Stack>
                  }
                  action={
                    env.claudePath && !env.claudeVersionOk ? (
                      env.claudeInstallKind === 'homebrew' ? (
                        <Text size="xs" c="dimmed">
                          Update in a terminal: <Code>{CLAUDE_COMMANDS.brewUpgrade}</Code>
                        </Text>
                      ) : (
                        <Button
                          size="xs"
                          variant="light"
                          color="red"
                          loading={installing === 'update'}
                          disabled={!!installing}
                          onClick={updateClaude}
                        >
                          Update Claude Code
                        </Button>
                      )
                    ) : undefined
                  }
                />
                {env.claudePath && <AccountRow env={env} />}
                <Row
                  label="resume-tailor skill"
                  value={env.skillDir}
                  badges={env.skillInstall ? [{ text: `${env.skillInstall.tag} · installed by Huntgry`, color: 'gray' }] : []}
                  missing={
                    <Button
                      size="xs"
                      loading={installing === 'skill'}
                      disabled={!!installing}
                      onClick={() => installSkill(false)}
                    >
                      Install resume-tailor skill
                    </Button>
                  }
                  action={
                    env.skillInstall ? (
                      <Button
                        size="xs"
                        variant="subtle"
                        loading={installing === 'reinstall-skill'}
                        disabled={!!installing}
                        onClick={() => installSkill(true)}
                      >
                        Reinstall
                      </Button>
                    ) : undefined
                  }
                />
                <Row
                  label="Python venv"
                  value={env.venvDir}
                  badges={[{ text: env.venvReady ? 'ready' : 'not created', color: 'gray' }]}
                />
                <Row label="LaTeX" value={env.texBin} />
              </Table.Tbody>
            </Table>
            {log.length > 0 && installing !== 'python' && (
              <ScrollArea.Autosize mah={200} mt="md">
                <Code block>{log.join('\n')}</Code>
                <div ref={logEnd} />
              </ScrollArea.Autosize>
            )}
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Group justify="space-between" mb="sm" wrap="nowrap" align="flex-start">
              <div>
                <Title order={4}>Skill dependencies</Title>
                <Text size="sm" c="dimmed">
                  Output of the skill's own <Code>scripts/preflight.py</Code>, run with the PATH a tailoring run gets.
                </Text>
              </div>
              <Button
                variant="light"
                loading={installing === 'python'}
                onClick={installPython}
                disabled={!env.skillDir || (!!installing && installing !== 'python')}
                style={{ flexShrink: 0 }}
              >
                {env.venvReady ? 'Reinstall Python dependencies' : 'Install Python dependencies'}
              </Button>
            </Group>
            {env.preflight.length > 0 ? (
              <Table striped highlightOnHover>
                <Table.Tbody>
                  {env.preflight.map((p, i) => (
                    <Table.Tr key={`${p.name}-${i}`}>
                      <Table.Td w={110}>
                        <Badge
                          color={STATUS[p.status].color}
                          variant="light"
                          leftSection={p.status === 'missing' ? <IconX size={12} /> : undefined}
                        >
                          {STATUS[p.status].label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>{p.name}</Table.Td>
                      <Table.Td c="dimmed">{p.detail}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            ) : (
              <Code block>{env.preflightOutput || 'The preflight check did not run (skill not found).'}</Code>
            )}
            {log.length > 0 && installing === 'python' && (
              <ScrollArea.Autosize mah={200} mt="md">
                <Code block>{log.join('\n')}</Code>
                <div ref={logEnd} />
              </ScrollArea.Autosize>
            )}
          </Card>

          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="xs">
              Installing LaTeX and poppler
            </Title>
            <Text size="sm" mb="xs">
              The skill compiles resumes with <Code>pdflatex</Code> and checks them with poppler. Without admin rights,
              TinyTeX installs into your home folder:
            </Text>
            <Code block>{`curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh
~/Library/TinyTeX/bin/universal-darwin/tlmgr install enumitem titlesec parskip
brew install poppler`}</Code>
            <Text size="sm" mt="xs" c="dimmed">
              Or install BasicTeX / MacTeX (<Code>brew install --cask basictex</Code>, asks for your password). Huntgry
              finds either one; your shell PATH does not need to change.
            </Text>
          </Card>
        </>
      )}
    </Stack>
  )
}

function AccountRow({ env }: { env: RunnerEnvironment }) {
  const auth = env.claudeAuth
  return (
    <Table.Tr>
      <Table.Th w={180}>Account</Table.Th>
      <Table.Td>
        {auth?.loggedIn ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" truncate>
              Signed in{auth.email ? ` as ${auth.email}` : ''}
            </Text>
            {auth.subscriptionType && (
              <Badge variant="light" color="gray" style={{ flexShrink: 0 }}>
                {auth.subscriptionType}
              </Badge>
            )}
          </Group>
        ) : auth ? (
          <Stack gap={4} align="flex-start">
            <Badge color="red" variant="light">
              Not signed in
            </Badge>
            <Text size="xs" c="dimmed">
              Sign in once in a terminal with <Code>{CLAUDE_COMMANDS.login}</Code>, then Check again. Claude Code needs a
              Pro, Max, Team, Enterprise or Console account.
            </Text>
          </Stack>
        ) : (
          <Badge color="gray" variant="light">
            Unknown
          </Badge>
        )}
      </Table.Td>
    </Table.Tr>
  )
}

function Row({
  label,
  value,
  badges = [],
  missing,
  action
}: {
  label: string
  value: string | null
  badges?: { text: string; color: string }[]
  /** Shown under "Not found" (e.g. an Install button). */
  missing?: ReactNode
  /** Shown under the value (e.g. an Update button). */
  action?: ReactNode
}) {
  return (
    <Table.Tr>
      <Table.Th w={180}>{label}</Table.Th>
      <Table.Td>
        {value ? (
          <Stack gap={4} align="flex-start">
            <Group gap="xs" wrap="nowrap" maw="100%">
              <Text size="sm" ff="monospace" truncate="start" style={{ minWidth: 0 }}>
                {/* truncate="start" uses direction: rtl; <bdi> keeps the leading "/" where it belongs. */}
                <bdi>{value}</bdi>
              </Text>
              {badges.map((b) => (
                <Badge key={b.text} variant="light" color={b.color} style={{ flexShrink: 0 }}>
                  {b.text}
                </Badge>
              ))}
            </Group>
            {action}
          </Stack>
        ) : (
          <Stack gap={6} align="flex-start">
            <Badge color="red" variant="light">
              Not found
            </Badge>
            {missing}
          </Stack>
        )}
      </Table.Td>
    </Table.Tr>
  )
}
