import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { appendLive, buildTranscript, LineBuffer, parseEventLine, summarizeToolInput } from '@shared/transcript'
import {
  allowedTools,
  texRootOf,
  buildClaudeArgs,
  buildFirstPrompt,
  requireStartParams,
  runTitle,
  userMessageLine
} from './command'
import {
  buildChildEnv,
  cliSearchDirs,
  composePath,
  E2E_ENV,
  findSkillDir,
  isolatedDiscovery,
  loginShellPath,
  parsePreflight,
  setPackagedBuild
} from './env'
import { fetchPostingText, htmlToText, type Fetcher } from './posting'
import { assertPublicUrl, isPrivateAddress, pinnedFetch, type ResolveHost } from './public-url'
import { findOutputFolder, newRunId, runDir, RUN_ID_PATTERN } from './runs'

let tmp: string
beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'huntgry-cli-'))
})
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true })
})

describe('preflight parsing', () => {
  it('reads the skill preflight output', () => {
    const out = [
      '--    docx not installed - python-docx, only needed for --docx output',
      '',
      'MISSING pdflatex - LaTeX compiler (TeX Live / MiKTeX)',
      'ok    pdftoppm',
      'ok    docx (optional)',
      'ok    LaTeX package geometry',
      'MISSING python module pydantic - schema validation (pip install pydantic)',
      'Install the above, then re-run preflight.'
    ].join('\n')
    expect(parsePreflight(out)).toEqual([
      { name: 'docx', status: 'optional', detail: 'not installed - python-docx, only needed for --docx output' },
      { name: 'pdflatex', status: 'missing', detail: 'LaTeX compiler (TeX Live / MiKTeX)' },
      { name: 'pdftoppm', status: 'ok', detail: '' },
      { name: 'docx', status: 'ok', detail: '' },
      { name: 'LaTeX package geometry', status: 'ok', detail: '' },
      { name: 'python module pydantic', status: 'missing', detail: 'schema validation (pip install pydantic)' }
    ])
  })
})

describe('child environment', () => {
  it('puts the venv, TeX and CLI folders first, sets CV_HOME and drops nested-session variables', () => {
    const env = buildChildEnv({
      base: {
        PATH: '/usr/bin:/bin',
        HOME: '/Users/x',
        CLAUDECODE: '1',
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        ANTHROPIC_API_KEY: 'k'
      },
      workspace: '/ws',
      venvDir: '/venv',
      texBin: '/tex/bin',
      loginPath: '/opt/homebrew/bin:/custom/bin',
      home: '/Users/x'
    })
    const path = env.PATH!.split(':')
    expect(path.slice(0, 3)).toEqual(['/venv/bin', '/tex/bin', '/Users/x/.local/bin'])
    expect(path).toContain('/custom/bin')
    expect(new Set(path).size).toBe(path.length)
    expect(env.CV_HOME).toBe('/ws')
    expect(env.CLAUDECODE).toBeUndefined()
    expect(env.CLAUDE_CODE_ENTRYPOINT).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBe('k')
  })

  it('composes PATH without blanks or duplicates', () => {
    expect(composePath('/a:/b', null, '', '/b:/c', undefined)).toBe('/a:/b:/c')
  })

  it('finds the shallowest installed skill and ignores folders without SKILL.md', async () => {
    const deep = join(tmp, 'skills/synced/abc/resume-tailor')
    const fake = join(tmp, 'plugins/resume-tailor')
    await mkdir(deep, { recursive: true })
    await mkdir(fake, { recursive: true })
    await writeFile(join(deep, 'SKILL.md'), '---\nname: resume-tailor\n---')
    expect(await findSkillDir([join(tmp, 'plugins'), join(tmp, 'skills')])).toBe(deep)
    const personal = join(tmp, 'skills/resume-tailor')
    await mkdir(personal, { recursive: true })
    await writeFile(join(personal, 'SKILL.md'), '')
    expect(await findSkillDir([join(tmp, 'skills')])).toBe(personal)
    expect(await findSkillDir([join(tmp, 'missing')])).toBeNull()
  })
})

describe('isolated CLI discovery (HUNTGRY_E2E, used by the e2e harness)', () => {
  afterEach(() => setPackagedBuild(true))

  it('is off unless the build is unpackaged and the variable is exactly "1"', () => {
    expect(isolatedDiscovery({ [E2E_ENV]: '1' }, true)).toBe(false)
    expect(isolatedDiscovery({}, false)).toBe(false)
    expect(isolatedDiscovery({ [E2E_ENV]: 'yes' }, false)).toBe(false)
    expect(isolatedDiscovery({ [E2E_ENV]: '1' }, false)).toBe(true)
    // The module default is "packaged", so nothing changes before main reports the build kind.
    expect(isolatedDiscovery({ [E2E_ENV]: '1' })).toBe(false)
    setPackagedBuild(false)
    expect(isolatedDiscovery({ [E2E_ENV]: '1' })).toBe(true)
  })

  it('searches only the folders below HOME and the app PATH, never the machine-wide folders or the login shell', async () => {
    setPackagedBuild(false)
    const dirs = await cliSearchDirs({ [E2E_ENV]: '1', PATH: '/tmp/fake-bin:/usr/bin' }, '/tmp/home')
    expect(dirs[0]).toBe('/tmp/home/.local/bin')
    expect(dirs).toContain('/tmp/fake-bin')
    expect(dirs).toContain('/usr/bin')
    expect(dirs).not.toContain('/opt/homebrew/bin')
    expect(dirs).not.toContain('/usr/local/bin')
    expect(dirs.every((d) => d.startsWith('/tmp/home/') || d === '/tmp/fake-bin' || d === '/usr/bin')).toBe(true)
    await expect(loginShellPath({ [E2E_ENV]: '1' })).resolves.toBe('')
  })

  it('keeps the machine-wide folders and the login-shell PATH out of the child PATH too', () => {
    setPackagedBuild(false)
    const env = buildChildEnv({
      base: { [E2E_ENV]: '1', PATH: '/sandbox/bin:/usr/bin', HOME: '/tmp/home' },
      workspace: '/ws',
      venvDir: '/venv',
      texBin: null,
      loginPath: '/opt/homebrew/bin:/Users/dev/.local/bin',
      home: '/tmp/home'
    })
    const path = env.PATH!.split(':')
    expect(path.slice(0, 3)).toEqual(['/venv/bin', '/tmp/home/.local/bin', '/tmp/home/.claude/local'])
    expect(path).toContain('/sandbox/bin')
    expect(path).not.toContain('/opt/homebrew/bin')
    expect(path).not.toContain('/usr/local/bin')
    expect(path).not.toContain('/Users/dev/.local/bin')
    // Off outside isolated mode: the same call without the variable keeps them.
    const normal = buildChildEnv({ base: { PATH: '/usr/bin' }, workspace: '/ws', venvDir: '/venv', texBin: null, loginPath: '/opt/homebrew/bin', home: '/tmp/home' })
    expect(normal.PATH!.split(':')).toContain('/opt/homebrew/bin')
    expect(normal.PATH!.split(':')).toContain('/usr/local/bin')
  })
})

const SANDBOX = {
  workspace: '/Users/x/cv',
  skillDir: '/s',
  venvDir: '/Users/x/venv',
  texRoot: '/Users/x/Library/TinyTeX'
}

describe('command line and prompts', () => {
  it('builds a headless, scoped claude invocation', () => {
    const args = buildClaudeArgs({ skillDir: '/s', systemPrompt: 'sys', resumeSessionId: 'abc', sandbox: SANDBOX })
    expect(args.slice(0, 7)).toEqual([
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode'
    ])
    // Older Claude Code (< 2.1.259) rejects --permission-prompts: only passed when the version supports it.
    expect(args).not.toContain('--permission-prompts')
    const newer = buildClaudeArgs({ skillDir: '/s', systemPrompt: 'sys', sandbox: SANDBOX, permissionPrompts: true })
    expect(newer[newer.indexOf('--permission-prompts') + 1]).toBe('none')
    expect(newer.slice(newer.indexOf('--permission-mode'), newer.indexOf('--permission-mode') + 2)).toEqual([
      '--permission-mode',
      'acceptEdits'
    ])
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain('--add-dir')
    // No inherited user/project/local settings (hooks, permission rules).
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual([
      '--setting-sources',
      ''
    ])
    expect(args.slice(-2)).toEqual(['--resume', 'abc'])
    expect(buildClaudeArgs({ skillDir: '/s', systemPrompt: 'sys', sandbox: SANDBOX })).not.toContain('--resume')
  })

  it('allows only the skill scripts in the shell, reads only the skill folder, and no file writes', () => {
    const tools = allowedTools('/skills/resume-tailor')
    for (const bare of ['Write', 'Edit', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'])
      expect(tools).not.toContain(bare)
    // No network tool at all: the posting text arrives in the first message.
    expect(tools.some((t) => /^Web(Fetch|Search)/.test(t))).toBe(false)
    expect(tools).toContain('Read(//skills/resume-tailor/**)')
    expect(tools).toContain('Bash(python3 /skills/resume-tailor/scripts/build.py:*)')
    expect(tools).toContain('Bash(python3 /skills/resume-tailor/scripts/preflight.py:*)')
    // Every shell rule is one of the skill's scripts.
    for (const t of tools.filter((x) => x.startsWith('Bash('))) {
      expect(t).toMatch(/^Bash\(python3 \/skills\/resume-tailor\/scripts\/[a-z_]+\.py:\*\)$/)
    }
    const spaced = allowedTools('/Users/a b/skill')
    expect(spaced).toContain('Bash(python3 "/Users/a b/skill/scripts/build.py":*)')
  })

  it('runs shell commands in a mandatory sandbox that cannot read the home folder', () => {
    const args = buildClaudeArgs({
      skillDir: '/s',
      systemPrompt: 'sys',
      sandbox: { ...SANDBOX, extraRead: ['/private/real/venv', '/s'] }
    })
    const settings = JSON.parse(args[args.indexOf('--settings') + 1])
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: false
    })
    expect(settings.sandbox.filesystem.denyRead).toEqual(['~/'])
    expect(settings.sandbox.filesystem.allowRead).toEqual([
      '/Users/x/cv',
      '/s',
      '/Users/x/venv',
      '/Users/x/Library/TinyTeX',
      '/private/real/venv'
    ])
  })

  it('finds the TeX root to allow', () => {
    expect(texRootOf('/Users/x/Library/TinyTeX/bin/universal-darwin')).toBe('/Users/x/Library/TinyTeX')
    expect(texRootOf('/Users/x/.TinyTeX/bin/x86_64-linux')).toBe('/Users/x/.TinyTeX')
    expect(texRootOf('/Library/TeX/texbin')).toBeNull()
    expect(texRootOf(null)).toBeNull()
  })

  it('writes the first prompt with the job and the choices', () => {
    const p = buildFirstPrompt({
      jobDescription: '## Senior Engineer\nGo, Kafka',
      jobUrl: 'https://x.com/j/1',
      company: 'Acme',
      coverLetter: false,
      dateStyle: 'inline'
    })
    expect(p).toContain('Job posting URL: https://x.com/j/1')
    expect(p).toContain('Cover letter: no')
    expect(p).toContain('Date style: inline')
    expect(p).toContain('<job_description>\n## Senior Engineer\nGo, Kafka\n</job_description>')
    const fromUrl = buildFirstPrompt({ jobUrl: 'https://x.com/j/1', coverLetter: true, dateStyle: 'right' })
    expect(fromUrl).not.toMatch(/fetch/i)
  })

  it('titles runs from role/company, URL host or the description', () => {
    expect(runTitle({ role: 'SRE', company: 'Acme', coverLetter: true, dateStyle: 'right' })).toBe('SRE · Acme')
    expect(runTitle({ jobUrl: 'https://www.indeed.com/viewjob?jk=1', coverLetter: true, dateStyle: 'right' })).toBe(
      'indeed.com'
    )
    expect(runTitle({ jobDescription: '# Staff Engineer, Payments\n...', coverLetter: true, dateStyle: 'right' })).toBe(
      'Staff Engineer, Payments'
    )
  })

  it('validates start parameters from the renderer', () => {
    expect(() => requireStartParams({ coverLetter: true })).toThrow(/job description/)
    expect(() => requireStartParams({ jobUrl: 'file:///etc/passwd' })).toThrow(/http/)
    expect(() => requireStartParams({ jobDescription: 5 })).toThrow(/Invalid job description/)
    expect(requireStartParams({ jobDescription: 'x', source: 'indeed' }).source).toBe('indeed')
    expect(requireStartParams({ jobDescription: 'x', source: '../../etc' }).source).toBeUndefined()
    expect(requireStartParams({ jobDescription: 'x', dateStyle: 'weird', coverLetter: 'yes' })).toMatchObject({
      dateStyle: 'right',
      coverLetter: false
    })
  })

  it('encodes a stdin user message', () => {
    expect(JSON.parse(userMessageLine('hi "there"'))).toEqual({
      type: 'user',
      message: { role: 'user', content: 'hi "there"' }
    })
  })
})

describe('stream parsing and transcript', () => {
  it('splits partial lines across chunks', () => {
    const b = new LineBuffer()
    expect(b.push('{"a":1}\n{"b"')).toEqual(['{"a":1}'])
    expect(b.push(':2}\r\n\n')).toEqual(['{"b":2}'])
    expect(b.push('{"c":3}')).toEqual([])
    expect(b.flush()).toEqual(['{"c":3}'])
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine('[1]')).toBeNull()
  })

  it('folds a recorded real claude turn into a transcript', async () => {
    const events = (await readFile(join(__dirname, 'fixtures/read-file-turn.jsonl'), 'utf8'))
      .split('\n')
      .map(parseEventLine)
      .filter(Boolean)
    const t = buildTranscript(events)
    expect(t.map((i) => i.kind)).toEqual(['tool', 'assistant', 'result'])
    expect(t[0]).toMatchObject({ name: 'Read', summary: 'note.txt', status: 'ok' })
    expect(t[1]).toMatchObject({ text: 'The secret word is pineapple.' })
    expect(t[2]).toMatchObject({ ok: true, denials: [] })
  })

  it('merges text blocks of one message, skips sub-agent turns and unknown events, marks interrupted tools', () => {
    const t = buildTranscript([
      { type: 'huntgry', subtype: 'user_message', text: 'go' },
      { type: 'something_new', x: 1 },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Part one.' }] } },
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Part two.' }] } },
      {
        type: 'assistant',
        parent_tool_use_id: 'x',
        message: { id: 'm2', content: [{ type: 'text', text: 'sub-agent' }] }
      },
      {
        type: 'assistant',
        message: {
          id: 'm3',
          content: [
            {
              type: 'tool_use',
              id: 't1',
              name: 'Bash',
              input: { command: 'python3 build.py', description: 'Build the resume' }
            }
          ]
        }
      },
      {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        total_cost_usd: 0.5,
        permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'rm -rf x' } }]
      }
    ])
    expect(t.map((i) => i.kind)).toEqual(['user', 'assistant', 'tool', 'result'])
    expect(t[1]).toMatchObject({ text: 'Part one.\n\nPart two.' })
    expect(t[2]).toMatchObject({ summary: 'Build the resume', status: 'error' })
    expect(t[3]).toMatchObject({ ok: false, costUsd: 0.5, denials: ['Bash rm -rf x'] })
  })

  it('merges live events into events read from disk without duplicates', () => {
    const fromDisk = ['e0', 'e1']
    expect(appendLive(fromDisk, 1, 'e1')).toBe(fromDisk)
    expect(appendLive(fromDisk, 2, 'e2')).toEqual(['e0', 'e1', 'e2'])
    let merged: unknown[] = []
    for (const [seq, e] of [
      [0, 'a'],
      [1, 'b'],
      [1, 'b'],
      [2, 'c']
    ] as const)
      merged = appendLive(merged, seq, e)
    expect(merged).toEqual(['a', 'b', 'c'])
  })

  it('summarizes tool inputs', () => {
    expect(summarizeToolInput('Write', { file_path: '/ws/a/b/resume_data.json' })).toBe('resume_data.json')
    expect(summarizeToolInput('WebFetch', { url: 'https://jobs.example.com/1' })).toBe('https://jobs.example.com/1')
    expect(summarizeToolInput('Skill', { skill: 'resume-tailor' })).toBe('resume-tailor')
    expect(summarizeToolInput('Unknown', null)).toBe('')
  })
})

describe('run store', () => {
  it('makes ids that match the pattern and refuses traversal', () => {
    expect(RUN_ID_PATTERN.test(newRunId(new Date(2026, 8, 29, 1, 2, 3)))).toBe(true)
    expect(newRunId(new Date(2026, 8, 29, 1, 2, 3))).toMatch(/^20260929-010203-/)
    expect(() => runDir('/ws', '../../etc')).toThrow()
  })

  it('finds the newest application folder written during the run, ignoring .huntgry and old ones', async () => {
    const old = join(tmp, 'eng/old-co/1')
    const fresh = join(tmp, 'eng/new-co/2')
    await mkdir(old, { recursive: true })
    await mkdir(fresh, { recursive: true })
    await mkdir(join(tmp, '.huntgry/runs/a/b'), { recursive: true })
    await writeFile(join(old, 'resume.pdf'), 'x')
    const past = new Date(Date.now() - 3_600_000)
    await utimes(join(old, 'resume.pdf'), past, past)
    const since = Date.now() - 1000
    expect(await findOutputFolder(tmp, since)).toBeNull()
    await writeFile(join(fresh, 'resume_data.json'), '{}')
    await writeFile(join(fresh, 'job-description.md'), 'jd')
    await writeFile(join(fresh, 'notes.txt'), 'ignored')
    expect(await findOutputFolder(tmp, since)).toEqual({
      folder: join('eng', 'new-co', '2'),
      files: ['job-description.md', 'resume_data.json']
    })
  })

  it("prefers the folder matching the run's role, company and job id over a newer one", async () => {
    const mine = join(tmp, 'engineer/acme/a1')
    const other = join(tmp, 'engineer/globex/b2')
    await mkdir(mine, { recursive: true })
    await mkdir(other, { recursive: true })
    const since = Date.now() - 1000
    await writeFile(join(mine, 'resume.pdf'), 'a')
    await new Promise((r) => setTimeout(r, 20))
    await writeFile(join(other, 'resume.pdf'), 'b')
    expect((await findOutputFolder(tmp, since))?.folder).toBe(join('engineer', 'globex', 'b2'))
    const hinted = await findOutputFolder(tmp, since, { prefer: { role: 'Engineer', company: 'Acme Inc', jobId: 'A1' } })
    expect(hinted?.folder).toBe(join('engineer', 'acme', 'a1'))
    // No match: the newest wins, but never a folder another live run owns.
    const globex = join('engineer', 'globex', 'b2')
    const acme = join('engineer', 'acme', 'a1')
    expect((await findOutputFolder(tmp, since, { prefer: { company: 'Initech' }, exclude: [globex] }))?.folder).toBe(acme)
    expect(await findOutputFolder(tmp, since, { exclude: [globex, acme] })).toBeNull()
  })

  it('never takes another job id that merely contains the run\'s job id', async () => {
    const other = join(tmp, 'engineer/acme/142')
    await mkdir(other, { recursive: true })
    const since = Date.now() - 1000
    await writeFile(join(other, 'resume.pdf'), 'b')
    const prefer = { role: 'Engineer', company: 'Acme', jobId: '42' }
    // A live run for job 142 owns that folder even before it records it.
    expect(await findOutputFolder(tmp, since, { prefer, claimedJobIds: ['142'] })).toBeNull()
    // Its own folder, once written, is an exact job-id match and wins over the newer 142 one.
    const mine = join(tmp, 'engineer/acme/42')
    await mkdir(mine, { recursive: true })
    await writeFile(join(mine, 'resume.pdf'), 'a')
    const past = new Date(Date.now() - 500)
    await utimes(join(mine, 'resume.pdf'), past, past)
    expect((await findOutputFolder(tmp, since, { prefer }))?.folder).toBe(join('engineer', 'acme', '42'))
  })
})

describe('posting fetch (main process, no network for Claude)', () => {
  const page =
    (body: string, type = 'text/html; charset=utf-8', status = 200): Fetcher =>
    async () =>
      new Response(body, { status, headers: { 'content-type': type } })
  const long = 'We build the routing platform for 2,000 vans. '.repeat(10)
  /** Every test host resolves to a public documentation address unless listed. */
  const dns =
    (overrides: Record<string, string[]> = {}): ResolveHost =>
    async (host) =>
      overrides[host] ?? ['203.0.113.10']

  it('prefers the JSON-LD JobPosting description', async () => {
    const html = `<html><head><script type="application/ld+json">${JSON.stringify({ '@graph': [{ '@type': 'JobPosting', title: 'SRE', hiringOrganization: { name: 'Acme' }, description: `<p>${long}</p><ul><li>Kubernetes &amp; Go</li></ul>` }] })}</script></head><body>nav junk</body></html>`
    const text = await fetchPostingText('https://jobs.example.com/1', page(html), dns())
    expect(text.startsWith('# SRE\n\nAcme\n\nWe build')).toBe(true)
    expect(text).toContain('- Kubernetes & Go')
    expect(text).not.toContain('nav junk')
  })

  it('falls back to the page text and refuses pages without content', async () => {
    const text = await fetchPostingText(
      'https://a.example/j',
      page(`<body><main><h1>Data Engineer</h1><p>${long}</p></main><script>x()</script></body>`),
      dns()
    )
    expect(text).toContain('Data Engineer')
    expect(text).not.toContain('x()')
    await expect(
      fetchPostingText('https://a.example/j', page('<body><div id="root"></div></body>'), dns())
    ).rejects.toThrow(/needs JavaScript.*Paste/)
    await expect(fetchPostingText('https://a.example/j', page('nope', 'text/html', 403), dns())).rejects.toThrow(
      /403.*Paste/
    )
    await expect(fetchPostingText('https://a.example/j', page('%PDF', 'application/pdf'), dns())).rejects.toThrow(
      /not a web page/
    )
    await expect(
      fetchPostingText(
        'https://a.example/j',
        async () => {
          throw new Error('ENOTFOUND')
        },
        dns()
      )
    ).rejects.toThrow(/Could not load/)
  })

  it('points to the Jobs page when a job board refuses the request', async () => {
    const refused = (status: number, headers: Record<string, string> = {}): Fetcher =>
      async () =>
        new Response('<html>Just a moment…</html>', { status, headers: { 'content-type': 'text/html', ...headers } })
    await expect(
      fetchPostingText('https://www.indeed.com/viewjob?jk=2bd2cff5c29c9fca', refused(401, { server: 'cloudflare' }), dns())
    ).rejects.toThrow(/^www\.indeed\.com does not let Huntgry read job pages directly\. Open the job on the Jobs page/)
    await expect(fetchPostingText('https://hiringcafe.com/job/1', refused(403), dns())).rejects.toThrow(
      /hiringcafe\.com does not let Huntgry.*Jobs page/
    )
    await expect(fetchPostingText('https://uk.indeed.com/viewjob?jk=1', refused(403), dns())).rejects.toThrow(/Jobs page/)
    // Any other Cloudflare bot wall: actionable, but no Jobs page hint.
    await expect(
      fetchPostingText('https://careers.example/1', refused(403, { server: 'cloudflare' }), dns())
    ).rejects.toThrow(/careers\.example does not let Huntgry.*human check.*Paste/)
    // Not a board, not Cloudflare, or not a refusal: the plain status.
    await expect(fetchPostingText('https://notindeed.com/1', refused(401), dns())).rejects.toThrow(/answered 401/)
    await expect(fetchPostingText('https://www.indeed.com/x', refused(500), dns())).rejects.toThrow(/answered 500/)
  })

  /** Serves `routes[url]`: a redirect target string, or HTML. Records every URL requested. */
  const site = (routes: Record<string, { redirect: string } | string>, seen: string[]): Fetcher =>
    async (url, init) => {
      expect(init.addresses).toEqual(['203.0.113.10'])
      seen.push(url)
      const route = routes[url]
      if (route === undefined) return new Response('missing', { status: 404 })
      if (typeof route === 'string') return new Response(route, { headers: { 'content-type': 'text/html' } })
      return new Response(null, { status: 302, headers: { location: route.redirect } })
    }

  it('follows public redirects, checking every hop', async () => {
    const seen: string[] = []
    const text = await fetchPostingText(
      'https://short.example/x',
      site({ 'https://short.example/x': { redirect: '/job' }, 'https://short.example/job': `<main>${long}</main>` }, seen),
      dns()
    )
    expect(text).toContain('routing platform')
    expect(seen).toEqual(['https://short.example/x', 'https://short.example/job'])
  })

  it('refuses redirects to loopback, private IPs and names that resolve to them', async () => {
    for (const target of ['http://127.0.0.1:8080/admin', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://intranet.example/']) {
      const seen: string[] = []
      await expect(
        fetchPostingText(
          'https://jobs.example/1',
          site({ 'https://jobs.example/1': { redirect: target } }, seen),
          dns({ 'intranet.example': ['10.0.0.5'] })
        )
      ).rejects.toThrow(/local or private-network/)
      expect(seen).toEqual(['https://jobs.example/1'])
    }
  })

  it('refuses a private start URL before any request and stops redirect loops', async () => {
    const seen: string[] = []
    await expect(fetchPostingText('http://192.168.1.1/', site({}, seen), dns())).rejects.toThrow(/private-network/)
    expect(seen).toEqual([])
    await expect(
      fetchPostingText('https://loop.example/a', site({ 'https://loop.example/a': { redirect: '/a' } }, seen), dns())
    ).rejects.toThrow(/redirects too many times/)
  })
})

describe('public URL guard', () => {
  it('classifies private and public addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', 'not-an-ip']) {
      expect(isPrivateAddress(a), a).toBe(true)
    }
    for (const a of ['8.8.8.8', '203.0.113.10', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(a), a).toBe(false)
    }
  })

  it('rejects non-http schemes and names resolving to any private address', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', async () => [])).rejects.toThrow(/http/)
    await expect(assertPublicUrl('https://mixed.example/', async () => ['8.8.8.8', '10.0.0.1'])).rejects.toThrow(/private/)
    await expect(assertPublicUrl('https://gone.example/', async () => { throw new Error('ENOTFOUND') })).rejects.toThrow(/Could not find/)
    expect(await assertPublicUrl('https://ok.example/p', async () => ['8.8.8.8', '2606:4700::1111'])).toMatchObject({
      url: new URL('https://ok.example/p'),
      addresses: ['8.8.8.8', '2606:4700::1111']
    })
    expect((await assertPublicUrl('http://8.8.8.8/', async () => [])).addresses).toEqual(['8.8.8.8'])
  })

  it('connects only to the pinned address, keeping the hostname for Host', async () => {
    // A name that does not resolve anywhere reaches the local test server only through the pin.
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/go' ? 302 : 200, { location: '/next', 'content-type': 'text/html' })
      res.end(req.url === '/go' ? '' : `host=${req.headers.host}`)
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const { port } = server.address() as AddressInfo
    try {
      const init = { signal: new AbortController().signal, headers: {}, addresses: ['127.0.0.1'] }
      const ok = await pinnedFetch(`http://pinned.invalid:${port}/page`, init)
      expect(ok.status).toBe(200)
      expect(await ok.text()).toBe(`host=pinned.invalid:${port}`)
      const redirect = await pinnedFetch(`http://pinned.invalid:${port}/go`, init)
      expect(redirect.status).toBe(302)
      expect(redirect.headers.get('location')).toBe('/next')
    } finally {
      server.close()
    }
  })
  it('decodes entities safely', () => {
    expect(htmlToText('<p>A&#99999999;B &#x1F600; &amp;</p>')).toBe('A&#99999999;B 😀 &')
  })
})
