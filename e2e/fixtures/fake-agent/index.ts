import { chmod, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AppFixture, Preparer, Sandbox } from '../app'

/**
 * Scripted `claude`, `codex` and `agy` for the Tailor and Settings flows. The
 * shims (`agent.mjs`) go into the sandbox `bin`, the fixture skill into the
 * sandbox `HOME`, and every spawn leaves a marker the tests read back, so a
 * spec can say which agent the app really started, when, and with which
 * session. See docs/testing/e2e.md, "Fake agents".
 *
 *   test.use({ workspace: 'demo', prepare: withFakeAgents() })
 *   const fakes = fakeAgents(app)
 *   await fakes.setScript('fail')
 *   expect((await fakes.runs()).map((r) => r.agent)).toEqual(['claude'])
 */

export const FAKE_AGENT_NAMES = ['claude', 'codex', 'agy'] as const
export type FakeAgentName = (typeof FAKE_AGENT_NAMES)[number]

/** What the shim does with a run; see the header of agent.mjs. */
export type FakeAgentScript = 'normal' | 'slow' | 'fail' | 'exit-early'

export interface FakeAgentConfig {
  script?: FakeAgentScript
  /** The pause before every event of a `slow` run (ms). */
  slowMs?: number
  /** What `claude --version` prints; the app wants at least `CLAUDE_VERSION_RECOMMENDED`. */
  claudeVersion?: string
  codexVersion?: string
  agyVersion?: string
}

export interface FakeAgentOptions extends FakeAgentConfig {
  /**
   * Where the fixture skill is installed: for every agent (default), only for
   * Claude (the other agents then need "Install skill" in Settings), or nowhere.
   */
  skills?: 'all' | 'claude' | 'none'
  /** Which shims to install (default: all three). */
  agents?: readonly FakeAgentName[]
  /** Plant a fake `pdflatex` in the sandbox HOME so LaTeX counts as installed (default true). */
  tex?: boolean
}

/** One line of `invocations.jsonl`. */
export interface FakeAgentInvocation {
  agent: FakeAgentName
  pid: number
  /** Epoch ms. */
  at: number
  mode?: 'version' | 'auth' | 'run'
  /** `run` only. */
  args?: string[]
  cwd?: string
  /** The session id the process was told to resume, or `null` for a fresh one. */
  resume?: string | null
  /** The session id the process announced (equal to `resume` when resumed). */
  session?: string
  /** Turn markers of a run, keyed by `pid`. */
  event?: 'turn-start' | 'turn-end'
  turn?: number
}

const HERE = resolve(__dirname)
const SHIM = join(HERE, 'agent.mjs')
const SKILL = join(HERE, 'skill')

/** Skill folders the app looks in per agent (see `skillRoots` in src/main/cli/agents/*.ts), relative to HOME. */
const SKILL_TARGETS: Record<FakeAgentName, string> = {
  claude: '.claude/skills/resume-tailor',
  codex: '.agents/skills/resume-tailor',
  agy: '.gemini/antigravity-cli/skills/resume-tailor'
}

/** `<sandbox>/fake-agent`: config, markers and per-session memory of the shims. */
export const fakeAgentHome = (sandbox: Pick<Sandbox, 'root'>): string => join(sandbox.root, 'fake-agent')

/** Where the fixture copies the skill for `agent` (same as the app's `skillTarget`). */
export const fakeSkillDir = (sandbox: Pick<Sandbox, 'home'>, agent: FakeAgentName = 'claude'): string =>
  join(sandbox.home, SKILL_TARGETS[agent])

/**
 * Installs the shims and the skill into a sandbox before the app starts.
 * Returns the extra environment the app gets: `HUNTGRY_CLAUDE_PATH` pinned to
 * the shim, so a `claude` below the sandbox HOME (`~/.local/bin`, which
 * discovery checks before PATH) can never take its place.
 */
export async function installFakeAgents(sandbox: Sandbox, opts: FakeAgentOptions = {}): Promise<Record<string, string>> {
  const home = fakeAgentHome(sandbox)
  await mkdir(home, { recursive: true })
  await writeConfig(home, opts)
  for (const agent of opts.agents ?? FAKE_AGENT_NAMES) {
    const shim = join(sandbox.bin, agent)
    // The sandbox PATH has no `node`; the wrapper names the runner's own binary.
    await writeFile(
      shim,
      `#!/bin/sh\nFAKE_AGENT_HOME=${quote(home)} exec ${quote(process.execPath)} ${quote(SHIM)} ${agent} "$@"\n`
    )
    await chmod(shim, 0o755)
  }
  const skills = opts.skills ?? 'all'
  if (skills !== 'none') {
    // Copies, not links: the Claude lookup (`findSkillDir`) skips symlinked folders.
    const targets = skills === 'all' ? FAKE_AGENT_NAMES : (['claude'] as const)
    for (const agent of targets) await cp(SKILL, fakeSkillDir(sandbox, agent), { recursive: true })
  }
  if (opts.tex !== false) {
    const texBin = join(sandbox.home, 'Library/TinyTeX/bin/universal-darwin')
    await mkdir(texBin, { recursive: true })
    await writeFile(join(texBin, 'pdflatex'), '#!/bin/sh\necho "fake pdflatex"\n')
    await chmod(join(texBin, 'pdflatex'), 0o755)
  }
  return (opts.agents ?? FAKE_AGENT_NAMES).includes('claude') ? { HUNTGRY_CLAUDE_PATH: join(sandbox.bin, 'claude') } : {}
}

/** `test.use({ prepare: withFakeAgents(opts) })`: the app fixture installs the fakes before launch. */
export function withFakeAgents(opts: FakeAgentOptions = {}): Preparer {
  return { prepare: ({ sandbox }) => installFakeAgents(sandbox, opts) }
}

async function writeConfig(home: string, config: FakeAgentConfig): Promise<void> {
  const { script, slowMs, claudeVersion, codexVersion, agyVersion } = config
  await writeFile(join(home, 'config.json'), JSON.stringify({ script, slowMs, claudeVersion, codexVersion, agyVersion }))
}

/** Reads the markers and changes the script of the shims of a launched app. */
export class FakeAgents {
  readonly home: string

  constructor(readonly sandbox: Sandbox) {
    this.home = fakeAgentHome(sandbox)
  }

  /** Path of a shim, as the app reports it. */
  bin(agent: FakeAgentName): string {
    return join(this.sandbox.bin, agent)
  }

  /** Changes what the next spawned shim does (a running one is not affected). */
  async setScript(script: FakeAgentScript, extra: Omit<FakeAgentConfig, 'script'> = {}): Promise<void> {
    await writeConfig(this.home, { script, ...extra })
  }

  /** Every line the shims wrote, oldest first. */
  async invocations(): Promise<FakeAgentInvocation[]> {
    let text: string
    try {
      text = await readFile(join(this.home, 'invocations.jsonl'), 'utf8')
    } catch {
      return []
    }
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as FakeAgentInvocation)
  }

  /** The processes that ran a conversation (not `--version` or `auth status`), oldest first. */
  async runs(): Promise<FakeAgentInvocation[]> {
    return (await this.invocations()).filter((i) => i.mode === 'run')
  }

  /** Start and end (ms) of the turns of every run process, for concurrency checks. */
  async turns(): Promise<{ agent: FakeAgentName; pid: number; turn: number; start: number; end: number | null }[]> {
    const all = await this.invocations()
    const out: { agent: FakeAgentName; pid: number; turn: number; start: number; end: number | null }[] = []
    for (const i of all) {
      if (i.event === 'turn-start') out.push({ agent: i.agent, pid: i.pid, turn: i.turn!, start: i.at, end: null })
      if (i.event === 'turn-end') {
        const t = out.find((x) => x.pid === i.pid && x.turn === i.turn)
        if (t) t.end = i.at
      }
    }
    return out
  }
}

export const fakeAgents = (app: Pick<AppFixture, 'sandbox'>): FakeAgents => new FakeAgents(app.sandbox)

function quote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
