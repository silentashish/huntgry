import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Button, Code, Group, List, Loader, Radio, ScrollArea, Select, Stack, Table, Text } from '@mantine/core'
import { IconAlertTriangle, IconCheck, IconCircleCheck, IconLink, IconRefresh, IconX } from '@tabler/icons-react'
import {
  AGENT_LABEL,
  CLAUDE_COMMANDS,
  type AgentId,
  type AgentStatus,
  type InstallResult,
  type PreflightItem,
  type RunnerEnvironment,
  type SkillUpdateStatus
} from '@shared/runner-types'
import { api, errorText } from '../../api'
import { MonoLabel, PageHeader, StatusPill, type UiTone } from '../../components/ui'
import { AppearanceCard } from './AppearanceCard'
import { PricingCard } from './PricingCard'
import { RemoteCard } from './RemoteCard'
import { SavedAnswersCard } from './SavedAnswersCard'
import { SectionNav, SettingsSection, type SettingsSectionId } from './SectionNav'
import { PathText, SettingsCard, toneOfColor } from './SettingsCard'
import { StandingApprovalsCard } from './StandingApprovalsCard'
import classes from './settings.module.css'

const STATUS: Record<PreflightItem['status'], { tone: UiTone; label: string }> = {
  ok: { tone: 'success', label: 'OK' },
  missing: { tone: 'danger', label: 'Missing' },
  optional: { tone: 'neutral', label: 'Optional' }
}

const INSTALL_KIND_LABEL = { native: 'native install', homebrew: 'Homebrew', npm: 'npm', other: '' } as const

type Installer = 'python' | 'claude' | 'update' | 'skill' | 'reinstall-skill' | 'sync-skill' | `link-${AgentId}`

/** Sections that need the runner environment (the agent check) before they render. */
const ENV_SECTIONS: readonly SettingsSectionId[] = [
  'agents',
  'standing-approvals',
  'saved-answers',
  'pricing',
  'claude',
  'skill-dependencies'
]
const ALWAYS_SECTIONS: readonly SettingsSectionId[] = ['remote-control', 'appearance']

/**
 * Settings (#116, Figma "Settings"): a sticky section nav on the left and the cards on the right:
 * the agent CLIs, standing approvals, saved answers, pricing, the Claude CLI and the skill's
 * dependencies, remote control and appearance.
 */
export function SettingsPage() {
  const [env, setEnv] = useState<RunnerEnvironment | null>(null)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Installer | null>(null)
  const [log, setLog] = useState<string[]>([])
  const [skillUpdate, setSkillUpdate] = useState<SkillUpdateStatus | null>(null)
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

  // One GitHub lookup per skill folder seen; a failure (offline, rate limit) just hides the badge.
  const skillDir = env?.skillDir ?? null
  const checkSkillUpdate = useCallback(async () => {
    try {
      setSkillUpdate(await api.runner.checkSkillUpdate())
    } catch {
      setSkillUpdate(null)
    }
  }, [])
  useEffect(() => {
    if (skillDir) void checkSkillUpdate()
    else setSkillUpdate(null)
  }, [skillDir, checkSkillUpdate])

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
  const linkSkill = (agent: AgentId) =>
    install(
      `link-${agent}`,
      () => api.runner.linkSkill(agent),
      `Installing the skill for ${AGENT_LABEL[agent]} failed.`
    )
  async function setCliPath(agent: AgentId, path?: string | null) {
    setError(null)
    try {
      const res = await api.runner.setCliPath(agent, path)
      if (!res.ok && res.error) setError(res.error)
      if (res.ok) await check()
    } catch (err) {
      setError(errorText(err))
    }
  }
  async function setDefault(agent: AgentId) {
    setError(null)
    try {
      await api.runner.setDefaultAgent(agent)
      await check()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const installSkill = (replace: boolean) =>
    install(
      replace ? 'reinstall-skill' : 'skill',
      () => api.runner.installSkill(replace),
      'Installing the resume-tailor skill failed.'
    ).then(checkSkillUpdate)
  const syncSkill = () =>
    install('sync-skill', () => api.runner.syncSkill(), 'Updating the resume-tailor skill failed.').then(
      checkSkillUpdate
    )

  const installLog = (
    <ScrollArea.Autosize mah={200} mt="md">
      <Code block>{log.join('\n')}</Code>
      <div ref={logEnd} />
    </ScrollArea.Autosize>
  )

  const sections = env ? [...ENV_SECTIONS, ...ALWAYS_SECTIONS] : ALWAYS_SECTIONS

  return (
    <Stack gap="lg">
      <PageHeader
        eyebrow="Agents, skill, pricing, memory and the phone link"
        title="Settings"
        subtitle="Everything here lives with the app's data, outside the workspace, so an agent can never change it."
        actions={
          <Button variant="default" leftSection={<IconRefresh size={16} />} loading={checking} onClick={check}>
            Check again
          </Button>
        }
      />

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
              {AGENT_LABEL[env.defaultAgent]} (the default agent), the resume-tailor skill and every dependency it needs
              to build PDFs are installed.
            </Alert>
          ) : (
            <Alert
              color="yellow"
              variant="light"
              icon={<IconAlertTriangle size={18} />}
              title="Not everything is in place"
            >
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
        </>
      )}

      <div className={classes.layout}>
        <SectionNav sections={sections} />
        <div className={classes.content}>
          {env && (
            <>
              <SettingsSection id="agents">
                <AgentsCard
                  env={env}
                  installing={installing}
                  onLinkSkill={linkSkill}
                  onSetDefault={setDefault}
                  onSetCliPath={setCliPath}
                />
              </SettingsSection>

              <SettingsSection id="standing-approvals">
                <StandingApprovalsCard />
              </SettingsSection>

              <SettingsSection id="saved-answers">
                <SavedAnswersCard />
              </SettingsSection>

              <SettingsSection id="pricing">
                <PricingCard />
              </SettingsSection>

              <div className={classes.pair}>
                <SettingsSection id="claude">
                  <ClaudeCard
                    env={env}
                    skillUpdate={skillUpdate}
                    installing={installing}
                    onInstallClaude={installClaude}
                    onUpdateClaude={updateClaude}
                    onInstallSkill={installSkill}
                    onSyncSkill={syncSkill}
                  >
                    {log.length > 0 && installing !== 'python' && installLog}
                  </ClaudeCard>
                </SettingsSection>

                <SettingsSection id="skill-dependencies">
                  <SettingsCard
                    title="Skill dependencies"
                    description={
                      <>
                        Output of the skill&apos;s own <Code>scripts/preflight.py</Code>, run with the PATH a tailoring
                        run gets.
                      </>
                    }
                    actions={
                      <Button
                        size="xs"
                        variant="subtle"
                        loading={installing === 'python'}
                        onClick={installPython}
                        disabled={!env.skillDir || (!!installing && installing !== 'python')}
                      >
                        {env.venvReady ? 'Reinstall Python dependencies' : 'Install Python dependencies'}
                      </Button>
                    }
                  >
                    {env.preflight.length > 0 ? (
                      <Table withRowBorders={false} className={classes.preflight} layout="fixed">
                        <Table.Tbody>
                          {env.preflight.map((p, i) => (
                            <Table.Tr key={`${p.name}-${i}`}>
                              <Table.Td w={96}>
                                <StatusPill
                                  tone={STATUS[p.status].tone}
                                  className={classes.monoPill}
                                  leftSection={p.status === 'missing' ? <IconX size={11} /> : undefined}
                                >
                                  {STATUS[p.status].label}
                                </StatusPill>
                              </Table.Td>
                              <Table.Td w="34%" className={classes.path} data-tone="primary">
                                {p.name}
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs" c="var(--hg-text-muted)">
                                  {p.detail}
                                </Text>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    ) : (
                      <Code block>{env.preflightOutput || 'The preflight check did not run (skill not found).'}</Code>
                    )}
                    {log.length > 0 && installing === 'python' && installLog}
                  </SettingsCard>
                </SettingsSection>
              </div>

              <SettingsCard title="Installing LaTeX and poppler">
                <Text size="sm" mb="xs" c="dimmed">
                  The skill compiles resumes with <Code>pdflatex</Code> and checks them with poppler. Without admin
                  rights, TinyTeX installs into your home folder:
                </Text>
                <Code block>{`curl -sL "https://yihui.org/tinytex/install-bin-unix.sh" | sh
~/Library/TinyTeX/bin/universal-darwin/tlmgr install enumitem titlesec parskip
brew install poppler`}</Code>
                <Text size="sm" mt="xs" c="dimmed">
                  Or install BasicTeX / MacTeX (<Code>brew install --cask basictex</Code>, asks for your password).
                  Huntgry finds either one; your shell PATH does not need to change.
                </Text>
              </SettingsCard>
            </>
          )}

          <SettingsSection id="remote-control">
            <RemoteCard />
          </SettingsSection>

          <SettingsSection id="appearance">
            <AppearanceCard />
          </SettingsSection>
        </div>
      </div>
    </Stack>
  )
}

/** The Claude CLI, the account, the skill folder, the Python venv and LaTeX, with their install buttons. */
function ClaudeCard({
  env,
  skillUpdate,
  installing,
  onInstallClaude,
  onUpdateClaude,
  onInstallSkill,
  onSyncSkill,
  children
}: {
  env: RunnerEnvironment
  skillUpdate: SkillUpdateStatus | null
  installing: Installer | null
  onInstallClaude(): void
  onUpdateClaude(): void
  onInstallSkill(replace: boolean): void
  onSyncSkill(): void
  /** The install log while one of this card's installs runs. */
  children?: ReactNode
}) {
  return (
    <SettingsCard title="Claude">
      <Table layout="fixed" className={classes.kvTable} verticalSpacing={8} horizontalSpacing={0}>
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
                <Button
                  size="xs"
                  variant="secondary"
                  loading={installing === 'claude'}
                  disabled={!!installing}
                  onClick={onInstallClaude}
                >
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
                    color="danger"
                    loading={installing === 'update'}
                    disabled={!!installing}
                    onClick={onUpdateClaude}
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
            badges={[
              ...(env.skillInstall ? [{ text: `${env.skillInstall.tag} · installed by Huntgry`, color: 'gray' }] : []),
              // Without a Huntgry install record the local version is unknown, so only the latest tag is shown.
              ...(!skillUpdate
                ? []
                : !skillUpdate.installed
                  ? [{ text: `latest: ${skillUpdate.latest}`, color: 'gray' }]
                  : skillUpdate.updateAvailable
                    ? [{ text: `${skillUpdate.latest} available`, color: 'blue' }]
                    : [{ text: 'up to date', color: 'green' }])
            ]}
            missing={
              <Button
                size="xs"
                variant="secondary"
                loading={installing === 'skill'}
                disabled={!!installing}
                onClick={() => onInstallSkill(false)}
              >
                Install resume-tailor skill
              </Button>
            }
            action={
              <Group gap={4}>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconRefresh size={14} />}
                  loading={installing === 'sync-skill'}
                  disabled={!!installing}
                  onClick={onSyncSkill}
                  title={`Install the latest release from GitHub over the copy in ~/.claude/skills (the old one is backed up)`}
                >
                  {skillUpdate?.updateAvailable && skillUpdate.installed
                    ? `Sync to ${skillUpdate.latest}`
                    : 'Sync from GitHub'}
                </Button>
                {env.skillInstall && (
                  <Button
                    size="xs"
                    variant="subtle"
                    loading={installing === 'reinstall-skill'}
                    disabled={!!installing}
                    onClick={() => onInstallSkill(true)}
                  >
                    Reinstall
                  </Button>
                )}
              </Group>
            }
          />
          <Row
            label="Python venv"
            value={env.venvDir}
            badges={[{ text: env.venvReady ? 'ready' : 'not created', color: env.venvReady ? 'green' : 'gray' }]}
          />
          <Row label="LaTeX" value={env.texBin} />
        </Table.Tbody>
      </Table>
      {children}
    </SettingsCard>
  )
}

/** Every agent a run can use: its CLI, whether it sees the skill, and which one new runs use. */
function AgentsCard({
  env,
  installing,
  onLinkSkill,
  onSetDefault,
  onSetCliPath
}: {
  env: RunnerEnvironment
  installing: Installer | null
  onLinkSkill(agent: AgentId): void
  onSetDefault(agent: AgentId): void
  /** `undefined`: pick a file in a dialog; `null`: remove the choice. */
  onSetCliPath(agent: AgentId, path?: string | null): void
}) {
  return (
    <SettingsCard
      title="Agents"
      description={
        <>
          The CLI that runs the resume-tailor skill. New runs use the default; the Tailor form and &quot;Tailor
          all&quot; can pick another one per job. Codex and Antigravity use the skill installed for Claude, linked into
          their own skills folder. When several copies of a CLI are installed, pick the one to run; Remove goes back to
          the first one found.
        </>
      }
    >
      <Radio.Group value={env.defaultAgent} onChange={(v) => onSetDefault(v as AgentId)}>
        <Table layout="fixed" withRowBorders={false} className={classes.agents}>
          <Table.Thead className={classes.srOnly}>
            <Table.Tr>
              <Table.Th>Agent</Table.Th>
              <Table.Th>CLI</Table.Th>
              <Table.Th>resume-tailor skill</Table.Th>
              <Table.Th>Choose the CLI</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {env.agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                isDefault={a.id === env.defaultAgent}
                canLink={!!env.skillDir}
                busy={!!installing}
                linking={installing === `link-${a.id}`}
                onLinkSkill={() => onLinkSkill(a.id)}
                onSetCliPath={(path) => onSetCliPath(a.id, path)}
              />
            ))}
          </Table.Tbody>
        </Table>
      </Radio.Group>
    </SettingsCard>
  )
}

function AgentRow({
  agent: a,
  isDefault,
  canLink,
  busy,
  linking,
  onLinkSkill,
  onSetCliPath
}: {
  agent: AgentStatus
  isDefault: boolean
  canLink: boolean
  busy: boolean
  linking: boolean
  onLinkSkill(): void
  onSetCliPath(path?: string | null): void
}) {
  const cliProblem = a.problems.find((p) => p.includes('CLI') || p.includes('signed in'))
  return (
    <Table.Tr data-default={isDefault || undefined}>
      <Table.Td w={200}>
        <Group gap={12} wrap="nowrap" align="center">
          <Radio id={`default-agent-${a.id}`} value={a.id} aria-label={`Make ${a.label} the default agent`} size="sm" />
          <Stack gap={2} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              {/* Clicking the name selects the agent, as the radio's label did before (#116). */}
              <label htmlFor={`default-agent-${a.id}`} className={classes.agentName}>
                {a.label}
              </label>
              <StatusPill tone={a.ready ? 'success' : 'danger'} dot>
                {a.ready ? 'Ready' : 'Not ready'}
              </StatusPill>
            </Group>
            {isDefault && <MonoLabel size="xs">default agent</MonoLabel>}
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        {a.cliPath ? (
          <Stack gap={4} align="flex-start">
            <Group gap={6} wrap="nowrap" maw="100%">
              <PathText>{a.cliPath}</PathText>
              <StatusPill className={classes.monoPill}>{a.version ?? 'version unknown'}</StatusPill>
            </Group>
            {cliProblem && (
              <Text size="xs" c="var(--hg-status-danger)">
                {cliProblem}
              </Text>
            )}
            <CliPicker agent={a} busy={busy} onSetCliPath={onSetCliPath} />
          </Stack>
        ) : (
          <Stack gap={2} align="flex-start">
            <span className={`${classes.path} ${classes.danger}`}>Not found</span>
            {cliProblem && (
              <Text size="xs" c="var(--hg-status-warning)">
                {cliProblem}
              </Text>
            )}
            <CliPicker agent={a} busy={busy} onSetCliPath={onSetCliPath} />
          </Stack>
        )}
      </Table.Td>
      <Table.Td w="32%">
        {a.skillPath ? (
          <Group gap={8} wrap="nowrap">
            <IconCircleCheck size={14} className={classes.success} style={{ flex: 'none' }} />
            <PathText>{a.skillPath}</PathText>
          </Group>
        ) : (
          <Stack gap={4} align="flex-start">
            <span className={`${classes.path} ${classes.danger}`}>Not installed</span>
            {a.id !== 'claude' &&
              (canLink ? (
                <>
                  <Button
                    size="xs"
                    variant="secondary"
                    leftSection={<IconLink size={14} />}
                    loading={linking}
                    disabled={busy}
                    onClick={onLinkSkill}
                  >
                    Install skill
                  </Button>
                  <Text size="xs" c="dimmed">
                    Links it at <Code>{a.skillTarget}</Code>
                  </Text>
                </>
              ) : (
                <Text size="xs" c="dimmed">
                  Install the resume-tailor skill for Claude first (below).
                </Text>
              ))}
            {a.id === 'claude' && (
              <Text size="xs" c="dimmed">
                Use &quot;Install resume-tailor skill&quot; below.
              </Text>
            )}
          </Stack>
        )}
      </Table.Td>
      <Table.Td w={100} ta="right">
        <CliButtons agent={a} busy={busy} onSetCliPath={onSetCliPath} />
      </Table.Td>
    </Table.Tr>
  )
}

/**
 * Which copy of an agent's CLI runs (#79): one of the copies found (this picker), another file
 * (Choose…) or, with Remove, the first copy found again (`CliButtons`).
 */
function CliPicker({
  agent: a,
  busy,
  onSetCliPath
}: {
  agent: AgentStatus
  busy: boolean
  onSetCliPath(path?: string | null): void
}) {
  if (a.cliPinned) return null
  const gone = a.cliChoice !== null && a.cliChoice !== a.cliPath
  if (a.cliCandidates.length <= 1 && !gone) return null
  return (
    <Stack gap={4} align="flex-start" w="100%">
      {a.cliCandidates.length > 1 && (
        <Select
          size="xs"
          w="100%"
          aria-label={`${a.label} CLI to use`}
          data={a.cliCandidates}
          value={a.cliPath}
          allowDeselect={false}
          disabled={busy}
          comboboxProps={{ withinPortal: true }}
          onChange={(v) => v && v !== a.cliPath && onSetCliPath(v)}
          styles={{ input: { fontFamily: 'var(--hg-font-mono)', fontSize: 11 } }}
        />
      )}
      {gone && (
        <Text size="xs" c="var(--hg-status-warning)">
          The chosen CLI <Code>{a.cliChoice}</Code> is gone; using the first copy found.
        </Text>
      )}
    </Stack>
  )
}

function CliButtons({
  agent: a,
  busy,
  onSetCliPath
}: {
  agent: AgentStatus
  busy: boolean
  onSetCliPath(path?: string | null): void
}) {
  if (a.cliPinned) return null
  return (
    <Stack gap={2} align="flex-end">
      <Button size="compact-xs" variant="subtle" disabled={busy} onClick={() => onSetCliPath()}>
        Choose…
      </Button>
      {a.cliChoice !== null && (
        <Button
          size="compact-xs"
          variant="subtle"
          color="red"
          disabled={busy}
          onClick={() => onSetCliPath(null)}
          aria-label={`Remove the chosen ${a.label} CLI`}
        >
          Remove
        </Button>
      )}
    </Stack>
  )
}

function AccountRow({ env }: { env: RunnerEnvironment }) {
  const auth = env.claudeAuth
  return (
    <Table.Tr>
      <Table.Th w={130}>Account</Table.Th>
      <Table.Td>
        {auth?.loggedIn ? (
          <Group gap="xs" wrap="nowrap">
            <Text size="sm" truncate>
              Signed in{auth.email ? ` as ${auth.email}` : ''}
            </Text>
            {auth.subscriptionType && <StatusPill>{auth.subscriptionType}</StatusPill>}
          </Group>
        ) : auth ? (
          <Stack gap={4} align="flex-start">
            <StatusPill tone="danger">Not signed in</StatusPill>
            <Text size="xs" c="dimmed">
              Sign in once in a terminal with <Code>{CLAUDE_COMMANDS.login}</Code>, then Check again. Claude Code needs
              a Pro, Max, Team, Enterprise or Console account.
            </Text>
          </Stack>
        ) : (
          <StatusPill>Unknown</StatusPill>
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
  /** Shown next to the value (e.g. an Update button). */
  action?: ReactNode
}) {
  return (
    <Table.Tr>
      <Table.Th w={130}>{label}</Table.Th>
      <Table.Td>
        {value ? (
          <Group gap={8} wrap="nowrap" align="flex-start" justify="space-between">
            <Stack gap={4} style={{ minWidth: 0, flex: 1 }} pt={2}>
              <PathText tone="primary">{value}</PathText>
              {badges.length > 0 && (
                <Group gap={4}>
                  {badges.map((b) => (
                    <StatusPill key={b.text} tone={toneOfColor(b.color)} className={classes.monoPill}>
                      {b.text}
                    </StatusPill>
                  ))}
                </Group>
              )}
            </Stack>
            {action != null && <div style={{ flex: 'none' }}>{action}</div>}
          </Group>
        ) : (
          <Stack gap={6} align="flex-start">
            <StatusPill tone="danger">Not found</StatusPill>
            {missing}
          </Stack>
        )}
      </Table.Td>
    </Table.Tr>
  )
}
