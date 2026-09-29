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
import { buildChildEnv, composePath, findSkillDir, parsePreflight } from './env'
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
    expect(args).toContain('--permission-prompts')
    expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none')
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
