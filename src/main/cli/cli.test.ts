import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildTranscript, LineBuffer, parseEventLine, summarizeToolInput } from '@shared/transcript'
import {
  ALLOWED_TOOLS,
  buildClaudeArgs,
  buildFirstPrompt,
  requireStartParams,
  runTitle,
  userMessageLine
} from './command'
import { buildChildEnv, composePath, findSkillDir, parsePreflight } from './env'
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

describe('command line and prompts', () => {
  it('builds a headless, scoped claude invocation', () => {
    const args = buildClaudeArgs({ skillDir: '/s', systemPrompt: 'sys', resumeSessionId: 'abc' })
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
    expect(args.slice(args.indexOf('--add-dir'), args.indexOf('--add-dir') + 2)).toEqual(['--add-dir', '/s'])
    expect(args.slice(-2)).toEqual(['--resume', 'abc'])
    expect(ALLOWED_TOOLS.filter((t) => t.startsWith('Bash(') && !/^Bash\([a-z0-9]+:\*\)$/.test(t))).toEqual([])
    expect(buildClaudeArgs({ skillDir: '/s', systemPrompt: 'sys' })).not.toContain('--resume')
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
    expect(fromUrl).toContain('Fetch the posting from the URL above')
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
