// The tailoring benchmark (#152): runs a fixed set of jobs unattended with a given agent, model and skill, and
// records time, cost and quality per run; `compare` writes a Markdown comparison of two bench runs.
// Manual only: a real bench spends money (about $1.30 a job on Opus 5.5) and is never part of npm test, CI or e2e.
// It never touches the real workspace: runs go to <out>/<bench-id>/workspace with a copy of the master profile,
// and an --out inside the workspace, the profile's folder or the set is refused. See docs/changes/152-tailoring-benchmark.md.
// Run: npm run bench:tailor -- --model claude-opus-5-5 --label baseline [--set <dir>] [--workspace <dir>] [--profile <file>]
//        [--out ~/huntgry-bench] [--claude <path>] [--skill-dir <dir>] [--venv <dir>] [--repeat N] [--jobs a,b]
//        [--timeout-min 15] [--claude-config-dir <dir>] [--dry-run]
//      npm run bench:compare -- <base results.json|dir> <candidate results.json|dir> [--out report.md] [--tolerance 2]
//      (Node 23+: it imports the TypeScript sources, like scripts/match-calibration.mjs)
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { registerHooks } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// The sources import without extensions and through the `@shared` alias; resolve both to the .ts files.
registerHooks({
  resolve(specifier, context, next) {
    const shared = specifier.startsWith('@shared/') ? join(root, 'src/shared', specifier.slice(8)) : null
    const relative = !shared && specifier.startsWith('.') && context.parentURL?.endsWith('.ts')
    const base = shared ?? (relative ? fileURLToPath(new URL(specifier, context.parentURL)) : null)
    if (base && !existsSync(base) && existsSync(`${base}.ts`)) return next(pathToFileURL(`${base}.ts`).href, context)
    if (base && existsSync(join(base, 'index.ts')) && !existsSync(`${base}.ts`)) return next(pathToFileURL(join(base, 'index.ts')).href, context)
    return next(specifier, context)
  }
})
const load = (path) => import(pathToFileURL(join(root, path)).href)

/** Today's numbers (63 Opus 5.5 runs, issue #152): what a bench run costs per job. */
const MEDIAN_COST_USD = 1.3
const MEDIAN_SECONDS = 195

/** Huntgry's userData folder (Electron's, with `app.setName('Huntgry')`). */
function userDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/Huntgry')
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'Huntgry')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Huntgry')
}

const expand = (p) => (p?.startsWith('~/') ? join(homedir(), p.slice(2)) : p)
const fail = (message) => {
  console.error(`bench: ${message}`)
  process.exit(2)
}

async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      set: { type: 'string' },
      workspace: { type: 'string' },
      profile: { type: 'string' },
      out: { type: 'string', default: '~/huntgry-bench' },
      claude: { type: 'string' },
      model: { type: 'string' },
      'skill-dir': { type: 'string' },
      venv: { type: 'string' },
      label: { type: 'string' },
      repeat: { type: 'string', default: '1' },
      jobs: { type: 'string' },
      'timeout-min': { type: 'string', default: '15' },
      'claude-config-dir': { type: 'string' },
      'dry-run': { type: 'boolean', default: false }
    }
  })
  const { loadSettings } = await load('src/main/workspace/settings.ts')
  const env = await load('src/main/cli/env.ts')
  const { claudeVersion, supportsPermissionPrompts } = await load('src/main/cli/version.ts')
  const { requireSignedIn } = await load('src/main/cli/install-claude.ts')
  const { readSkillInstall } = await load('src/main/cli/install-skill.ts')
  const { loadBenchSet } = await load('src/main/bench/set.ts')
  const { runBench } = await load('src/main/bench/run.ts')

  // The app's own choices (Settings → Agents): the same claude binary, account and skill an app run would use.
  const userData = userDataDir()
  const settings = await loadSettings(join(userData, 'settings.json'))
  env.setCliChoices(settings.cliPaths)
  const configDir = expand(values['claude-config-dir']) ?? settings.claudeConfigDir ?? null
  env.setClaudeConfigChoice(configDir)

  if (!values.model) fail('--model is required (e.g. --model claude-opus-5-5): a comparison needs the model on record.')
  const workspace = expand(values.workspace) ?? settings.currentWorkspace ?? null
  const profile = expand(values.profile) ?? (workspace ? join(workspace, 'master-profile.md') : null)
  if (!profile || !existsSync(profile)) fail(`no master profile at ${profile ?? '(none)'}; pass --profile <file> or --workspace <dir>.`)
  const setDir = expand(values.set) ?? (workspace ? join(workspace, '.huntgry/bench') : null)
  if (!setDir || !existsSync(setDir)) fail(`no bench set at ${setDir ?? '(none)'}; pass --set <dir> (see docs/changes/152-tailoring-benchmark.md).`)
  const set = await loadBenchSet(setDir)
  const only = values.jobs ? values.jobs.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  const repeat = Math.max(1, Number.parseInt(values.repeat, 10) || 1)
  const timeoutMin = Number(values['timeout-min'])
  if (!(timeoutMin > 0)) fail('--timeout-min must be a positive number.')

  const command = expand(values.claude) ?? (await env.findClaude())
  if (!command) fail('the claude CLI was not found; pass --claude <path>.')
  const skillDir = expand(values['skill-dir']) ?? (await env.findSkillDir())
  if (!skillDir || !existsSync(join(skillDir, 'SKILL.md'))) fail(`the resume-tailor skill was not found${skillDir ? ` at ${skillDir}` : ''}; pass --skill-dir <dir>.`)
  const venvDir = expand(values.venv) ?? join(userData, 'skill-venv')
  if (!existsSync(join(venvDir, 'bin/python3'))) fail(`no Python venv at ${venvDir} (Settings → Install sets it up); pass --venv <dir>.`)
  const texBin = await env.findTexBin()
  const loginPath = await env.loginShellPath()
  const childEnv = env.buildChildEnv({ base: process.env, workspace: '', venvDir, texBin, loginPath, claudeConfigDir: configDir })
  const version = await claudeVersion(command, childEnv)
  const record = await readSkillInstall(join(userData, 'skill-install.json'))
  const real = (p) => realpath(p).catch(() => p)
  const skillTag = record && (await real(record.path)) === (await real(skillDir)) ? record.tag : null

  const jobs = only ? set.jobs.filter((j) => only.includes(j.id)) : set.jobs
  const runs = jobs.length * repeat
  console.log(
    [
      `Bench set ${set.dir}: ${runs} run${runs === 1 ? '' : 's'} (${jobs.length} job${jobs.length === 1 ? '' : 's'} × ${repeat}).`,
      `Agent: ${command} (Claude Code ${version ?? 'unknown version'}), model ${values.model}, skill ${skillDir}${skillTag ? ` (${skillTag})` : ''}.`,
      `Profile: ${profile} (copied, never written). Output: ${expand(values.out)}.`,
      `Cost warning: this spends real money, about $${(runs * MEDIAN_COST_USD).toFixed(2)} and ${Math.round((runs * MEDIAN_SECONDS) / 60)} min at today's median ($${MEDIAN_COST_USD.toFixed(2)} and ${MEDIAN_SECONDS} s a run on Opus 5.5).`
    ].join('\n')
  )
  if (values['dry-run']) return
  await requireSignedIn(command, childEnv)

  const abort = new AbortController()
  process.on('SIGINT', () => {
    if (abort.signal.aborted) process.exit(130)
    console.error('\nStopping the current run and writing the results so far (Ctrl-C again to quit at once)…')
    abort.abort()
  })
  const { dir, results } = await runBench({
    set,
    profile,
    // The base cover letter that sits next to the profile, as in a workspace.
    coverLetter: existsSync(join(dirname(profile), 'cover-letter.md')) ? join(dirname(profile), 'cover-letter.md') : null,
    sourceWorkspace: workspace,
    out: expand(values.out),
    label: values.label ?? `${values.model}-${new Date().toISOString().slice(0, 10)}`,
    agent: 'claude',
    command,
    model: values.model,
    agentVersion: version,
    permissionPrompts: supportsPermissionPrompts(version),
    skillDir,
    skillTag,
    venvDir,
    texBin,
    loginPath,
    claudeConfigDir: configDir,
    repeat,
    only,
    timeoutMs: timeoutMin * 60_000,
    signal: abort.signal,
    log: (line) => console.log(line)
  })
  console.log(`\n${results.rows.length} run${results.rows.length === 1 ? '' : 's'} recorded in ${dir}\n  results: ${join(dir, 'results.json')}\n  report:  ${join(dir, 'report.md')}`)
}

function readResults(path) {
  const file = existsSync(join(path, 'results.json')) ? join(path, 'results.json') : path
  const r = JSON.parse(readFileSync(file, 'utf8'))
  if (r?.version !== 1 || !Array.isArray(r.rows)) fail(`${file} is not a bench results.json (version 1).`)
  return r
}

async function compare(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, tolerance: { type: 'string', default: '2' } }
  })
  if (positionals.length !== 2) fail('usage: npm run bench:compare -- <base results.json|dir> <candidate results.json|dir> [--out report.md]')
  const { compareBench } = await load('src/main/bench/report.ts')
  const md = compareBench(readResults(expand(positionals[0])), readResults(expand(positionals[1])), { tolerance: Number(values.tolerance) })
  if (values.out) writeFileSync(expand(values.out), md)
  else process.stdout.write(md)
}

const [command, ...rest] = process.argv.slice(2)
try {
  if (command === 'run') await run(rest)
  else if (command === 'compare') await compare(rest)
  else fail('usage: node scripts/bench-tailor.mjs run|compare …')
} catch (err) {
  console.error(`bench: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
