import { useCallback, useEffect, useRef, useState } from 'react'
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
import { IconCheck, IconRefresh, IconX } from '@tabler/icons-react'
import type { PreflightItem, RunnerEnvironment } from '@shared/runner-types'
import { api, errorText } from '../../api'

const STATUS: Record<PreflightItem['status'], { color: string; label: string }> = {
  ok: { color: 'green', label: 'OK' },
  missing: { color: 'red', label: 'Missing' },
  optional: { color: 'gray', label: 'Optional' }
}

/** Where the Claude CLI and the resume-tailor skill are, and whether their dependencies are installed. */
export function SettingsPage() {
  const [env, setEnv] = useState<RunnerEnvironment | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
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

  async function install() {
    setInstalling(true)
    setLog([])
    try {
      const res = await api.runner.installPythonDeps()
      if (!res.ok) setError(res.error ?? 'Installing Python dependencies failed.')
      await check()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setInstalling(false)
    }
  }

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

          <Card withBorder radius="md" padding="lg">
            <Title order={4} mb="sm">
              Claude
            </Title>
            <Table layout="fixed">
              <Table.Tbody>
                <Row label="Claude CLI" value={env.claudePath} extra={env.claudeVersion} />
                <Row label="resume-tailor skill" value={env.skillDir} />
                <Row label="Python venv" value={env.venvDir} extra={env.venvReady ? 'ready' : 'not created'} />
                <Row label="LaTeX" value={env.texBin} />
              </Table.Tbody>
            </Table>
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
                loading={installing}
                onClick={install}
                disabled={!env.skillDir}
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
            {log.length > 0 && (
              <ScrollArea h={200} mt="md">
                <Code block>{log.join('\n')}</Code>
                <div ref={logEnd} />
              </ScrollArea>
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

function Row({ label, value, extra }: { label: string; value: string | null; extra?: string | null }) {
  return (
    <Table.Tr>
      <Table.Th w={180}>{label}</Table.Th>
      <Table.Td>
        {value ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" ff="monospace" truncate="start" style={{ minWidth: 0 }}>
              {/* truncate="start" uses direction: rtl; <bdi> keeps the leading "/" where it belongs. */}
              <bdi>{value}</bdi>
            </Text>
            {extra && (
              <Badge variant="light" color="gray" style={{ flexShrink: 0 }}>
                {extra}
              </Badge>
            )}
          </Group>
        ) : (
          <Badge color="red" variant="light">
            Not found
          </Badge>
        )}
      </Table.Td>
    </Table.Tr>
  )
}
