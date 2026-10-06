import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  answersFile,
  clearAnswers,
  forgetFact,
  forgetQuestion,
  pageAnswers,
  readAnswers,
  rememberAnswer,
  rememberMappings,
  savedAnswers,
  setAnswersRoot
} from './answers-store'
import { questionKey } from '@shared/apply-facts'
import { parseFillReport } from './validate'
import { agyMappingArgs, claudeMappingArgs, mapQuestions, parseMappingOutput, type MapQuestion } from './map-questions'

let root: string
let ws: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'huntgry-answers-'))
  ws = join(root, 'workspace')
  await mkdir(ws)
  setAnswersRoot(join(root, 'userData', 'apply-answers'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('answers store', () => {
  it('keeps answers under userData, keyed by the workspace, never inside it', async () => {
    await rememberAnswer(ws, { question: 'choice|gender|x', label: 'Gender', fact: 'gender', value: 'Decline to self-identify' })
    const file = answersFile(ws)
    expect(file.startsWith(join(root, 'userData', 'apply-answers'))).toBe(true)
    expect(file.startsWith(ws)).toBe(false)
    expect(((await stat(file)).mode & 0o777).toString(8)).toBe('600')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    expect(raw.facts.gender.value).toBe('decline')
    expect(raw.questions['choice|gender|x']).toMatchObject({ fact: 'gender', source: 'user', confirmed: true })
  })

  it('stores a direct answer for a question without a fact, and serializes concurrent writes', async () => {
    await Promise.all([
      rememberAnswer(ws, { question: 'text|why us|0', label: 'Why us?', fact: null, value: 'The mission.' }),
      rememberAnswer(ws, { question: 'choice|sponsor|1', label: 'Sponsorship?', fact: 'needsSponsorship', value: 'No' })
    ])
    const answers = await readAnswers(ws)
    expect(answers.facts.needsSponsorship?.value).toBe('no')
    expect(answers.questions['text|why us|0']).toMatchObject({ value: 'The mission.', confirmed: true })
    expect(savedAnswers(answers).questions).toEqual([expect.objectContaining({ label: 'Why us?', value: 'The mission.' })])
    expect(savedAnswers(answers).facts).toEqual([expect.objectContaining({ fact: 'needsSponsorship', value: 'no', sensitive: false })])
  })

  it("keeps a model's mappings unconfirmed and never over the user's own", async () => {
    await rememberAnswer(ws, { question: 'q-user', label: 'Gender', fact: 'gender', value: 'Female' })
    await rememberMappings(ws, [
      { question: 'q-user', label: 'Gender', fact: 'pronouns' },
      { question: 'q-model', label: 'Your gender identity', fact: 'gender' }
    ])
    const page = pageAnswers(await readAnswers(ws))
    expect(page.questions['q-user']).toEqual({ fact: 'gender', confirmed: true })
    expect(page.questions['q-model']).toEqual({ fact: 'gender', confirmed: false })
    expect(page.facts).toEqual({ gender: 'Female' })
  })

  it('puts stored facts over the profile seeds', async () => {
    expect(pageAnswers(await readAnswers(ws), { workAuthorized: 'yes', needsSponsorship: 'no' }).facts).toEqual({
      workAuthorized: 'yes',
      needsSponsorship: 'no'
    })
    await rememberAnswer(ws, { question: 'q', label: 'Sponsorship', fact: 'needsSponsorship', value: 'Yes' })
    expect(pageAnswers(await readAnswers(ws), { needsSponsorship: 'no' }).facts.needsSponsorship).toBe('yes')
  })

  it('forgets one fact, one question, or everything (the file is gone)', async () => {
    await rememberAnswer(ws, { question: 'q1', label: 'Gender', fact: 'gender', value: 'Male' })
    await rememberAnswer(ws, { question: 'q2', label: 'Why?', fact: null, value: 'Because.' })
    expect((await forgetFact(ws, 'gender')).facts.gender).toBeUndefined()
    expect((await forgetQuestion(ws, 'q2')).questions.q2).toBeUndefined()
    expect((await readAnswers(ws)).questions.q1).toBeDefined()
    await clearAnswers(ws)
    await expect(stat(answersFile(ws))).rejects.toThrow()
    expect(await readAnswers(ws)).toEqual({ facts: {}, questions: {} })
  })

  it('reads a corrupt or hand-edited file as empty or cleaned up', async () => {
    await mkdir(join(answersFile(ws), '..'), { recursive: true })
    await writeFile(answersFile(ws), '{ nope')
    expect(await readAnswers(ws)).toEqual({ facts: {}, questions: {} })
    await writeFile(
      answersFile(ws),
      JSON.stringify({ facts: { gender: { value: 'x' }, shoeSize: { value: '9' } }, questions: { q: { fact: 'nope', source: 'model', confirmed: true } } })
    )
    const answers = await readAnswers(ws)
    expect(Object.keys(answers.facts)).toEqual(['gender'])
    // Only the user confirms: a file claiming a confirmed model mapping is not trusted.
    expect(answers.questions.q).toMatchObject({ fact: null, confirmed: false })
  })
})

describe('question mapping call', () => {
  const script = join(__dirname, 'fixtures/fake-mapper.mjs')
  const QUESTIONS: MapQuestion[] = [
    { id: 'q1', question: 'What is your gender identity?', kind: 'select', options: ['Man', 'Woman'] },
    { id: 'q2', question: 'Do you need an employer to sponsor you?', kind: 'radio', options: ['Yes', 'No'] },
    { id: 'q3', question: 'Why do you want to work here?', kind: 'textarea', options: [] }
  ]
  const run = async (env: Record<string, string>, agent: 'claude' | 'antigravity' = 'claude') => {
    const log = join(root, 'calls.jsonl')
    const result = mapQuestions(QUESTIONS, {
      agent,
      command: process.execPath,
      args: [script],
      env: { ...process.env, FAKE_MAPPER_LOG: log, ...env },
      timeoutMs: 3000
    })
    return { result, calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin: string }) }
  }

  it('runs Haiku once, tool-less, with no settings, MCP servers or saved session', async () => {
    const args = claudeMappingArgs()
    expect(args[args.indexOf('--model') + 1]).toBe('haiku')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('')
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(args).toContain('--json-schema')
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(claudeMappingArgs({ permissionPrompts: true })).toContain('--permission-prompts')
    const { result, calls } = await run({})
    expect(await result).toEqual([
      { id: 'q1', fact: 'gender' },
      { id: 'q2', fact: 'needsSponsorship' },
      { id: 'q3', fact: null }
    ])
    const made = await calls()
    expect(made).toHaveLength(1)
    // The prompt holds the questions and options; the call never carries a stored answer.
    expect(made[0].stdin).toContain('What is your gender identity?')
    expect(made[0].stdin).not.toMatch(/Female|decline/i)
  })

  it('runs agy with Gemini Flash Low, sandboxed, the prompt as the value of --print=', async () => {
    const args = agyMappingArgs('Questions: []')
    expect(args[args.indexOf('--model') + 1]).toBe('gemini-3.8-flash-low')
    expect(args).toContain('--sandbox')
    expect(args).toContain('--disable-slash-commands')
    expect(args.at(-1)).toMatch(/^--print=You classify questions[\s\S]*Questions: \[\]$/)
    const { result, calls } = await run({}, 'antigravity')
    expect((await result).map((m) => m.fact)).toEqual(['gender', 'needsSponsorship', null])
    expect((await calls())[0].stdin).toBe('')
  })

  it('drops unknown ids and fact keys, and fails on malformed output, errors and timeouts', async () => {
    expect(await (await run({ FAKE_MAPPER: 'unknown' })).result).toEqual([
      { id: 'q3', fact: null },
      { id: 'q2', fact: 'needsSponsorship' },
      { id: 'q1', fact: 'gender' }
    ])
    await expect((await run({ FAKE_MAPPER: 'bad' })).result).rejects.toThrow(/unexpected/)
    await expect((await run({ FAKE_MAPPER: 'error' })).result).rejects.toThrow(/rate limited/)
    const stall = mapQuestions(QUESTIONS, { agent: 'claude', command: process.execPath, args: [script], env: { ...process.env, FAKE_MAPPER: 'stall' }, timeoutMs: 300 })
    await expect(stall).rejects.toThrow(/claude failed/)
    await expect(mapQuestions(QUESTIONS, { agent: 'claude', command: join(root, 'no-such-cli'), env: process.env })).rejects.toThrow()
    expect(parseMappingOutput(JSON.stringify({ result: { structured_output: { mappings: [{ id: 'a', factKey: 'over18' }] } } }), new Set(['a']))).toEqual([
      { id: 'a', fact: 'over18' }
    ])
  })
})

describe('answer fields in a page report', () => {
  it('bounds what a page sends and derives the memory key itself', () => {
    const report = parseFillReport({
      ats: 'lever',
      url: 'https://jobs.lever.co/a/b/apply',
      fields: [
        {
          key: null,
          label: 'Gender',
          kind: 'select',
          outcome: 'skipped-unsupported',
          fieldId: 'select:eeo[gender]',
          question: 'choice|will you require visa sponsorship|deadbeef',
          fact: 'gender',
          options: ['Male', 'Female', 7, 'x'.repeat(500), ...Array.from({ length: 50 }, (_, i) => `o${i}`)],
          suggestion: 'Female',
          suggestedBy: 'evil'
        },
        { key: 'email', label: 'Email', kind: 'text', outcome: 'filled', fieldId: 'text:email', fact: 'shoeSize' },
        { key: null, label: 'Consent', kind: 'checkbox', outcome: 'skipped-unsupported', fieldId: 'checkbox:c', options: ['a'] }
      ]
    })
    const [gender, email, consent] = report.fields
    expect(gender.question).toBe(questionKey('Gender', 'select', gender.options))
    expect(gender.options).toHaveLength(30)
    expect(gender.options![2]).toHaveLength(120)
    expect(gender).toMatchObject({ fact: 'gender', suggestion: 'Female', suggestedBy: 'saved' })
    expect(email.fieldId).toBeUndefined()
    expect(email.fact).toBeUndefined()
    expect(consent.fieldId).toBeUndefined()
  })
})
