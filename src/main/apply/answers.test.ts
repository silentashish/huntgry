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
  setAnswersRoot,
  setFact
} from './answers-store'
import { questionKey } from '@shared/apply-facts'
import { parseEdits, parseFillReport } from './validate'
import { agyDraftArgs, claudeDraftArgs, draftAnswers, draftPrompt, parseDraftOutput } from './draft-answers'
import { agyMappingArgs, claudeMappingArgs, isCompanySpecificQuestion, mappingPrompt, mapQuestions, parseMappingOutput, type MapContext, type MapQuestion } from './map-questions'

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
    expect(page.questions['q-user']).toEqual({ fact: 'gender', confirmed: true, option: 'Female' })
    expect(page.questions['q-model']).toEqual({ fact: 'gender', confirmed: false })
    expect(page.facts).toEqual({ gender: 'Female' })
  })

  it("stores a model's probable answers unconfirmed, sends them to the page, never one for a sensitive fact (#136)", async () => {
    await rememberMappings(ws, [
      { question: 'q-go', label: 'Experience with Go?', fact: null, value: 'Yes' },
      { question: 'q-g', label: 'Your gender', fact: 'gender', value: 'Woman' },
      { question: 'q-yrs', label: 'Years of experience?', fact: 'yearsExperience', value: '7' }
    ])
    const stored = await readAnswers(ws)
    expect(stored.questions['q-go']).toMatchObject({ value: 'Yes', source: 'model', confirmed: false })
    expect(stored.questions['q-g'].value).toBeUndefined()
    const page = pageAnswers(stored)
    expect(page.questions['q-go']).toEqual({ fact: null, confirmed: false, value: 'Yes' })
    expect(page.questions['q-yrs']).toEqual({ fact: 'yearsExperience', confirmed: false, value: '7' })
    expect(page.questions['q-g']).toEqual({ fact: 'gender', confirmed: false })
    // Model answers are not "saved answers" in Settings until the user gives or corrects them.
    expect(savedAnswers(stored).questions).toEqual([])
    // The user's correction replaces the model's entry.
    await rememberAnswer(ws, { question: 'q-go', label: 'Experience with Go?', fact: null, value: 'No' })
    expect((await readAnswers(ws)).questions['q-go']).toMatchObject({ value: 'No', source: 'user', confirmed: true })
    // A hand-edited file cannot slip a model answer in for a sensitive fact.
    const raw = JSON.parse(await readFile(answersFile(ws), 'utf8'))
    raw.questions['q-g'].value = 'Woman'
    await writeFile(answersFile(ws), JSON.stringify(raw))
    expect((await readAnswers(ws)).questions['q-g'].value).toBeUndefined()
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
    const forgotten = await forgetFact(ws, 'gender')
    expect(forgotten.facts.gender).toBeUndefined()
    // The exact option remembered for the gender question goes with it.
    expect(forgotten.questions.q1).toMatchObject({ fact: 'gender', confirmed: true })
    expect(forgotten.questions.q1.option).toBeUndefined()
    expect((await forgetQuestion(ws, 'q2')).questions.q2).toBeUndefined()
    expect((await readAnswers(ws)).questions.q1).toBeDefined()
    await clearAnswers(ws)
    await expect(stat(answersFile(ws))).rejects.toThrow()
    expect(await readAnswers(ws)).toEqual({ facts: {}, questions: {} })
  })

  it('sets a fact directly in its stored form, and forgets it on an empty value (#136)', async () => {
    await setFact(ws, 'needsSponsorship', 'Yes', new Date('2026-10-17T00:00:00Z'))
    await setFact(ws, 'yearsExperience', ' 6 ')
    await setFact(ws, 'gender', 'Prefer not to say')
    await setFact(ws, 'visaStatus', 'H-1B')
    let answers = await readAnswers(ws)
    expect(answers.facts.needsSponsorship).toEqual({ value: 'yes', updatedAt: '2026-10-17T00:00:00.000Z' })
    expect(answers.facts.yearsExperience?.value).toBe('6')
    expect(answers.facts.gender?.value).toBe('decline')
    expect(answers.facts.visaStatus?.value).toBe('H-1B')
    // Under userData, never in the workspace.
    expect(answersFile(ws).startsWith(ws)).toBe(false)
    answers = await setFact(ws, 'yearsExperience', '')
    expect(answers.facts.yearsExperience).toBeUndefined()
    // A yes/no fact takes yes, no or decline only; anything too long is refused.
    await expect(setFact(ws, 'over18', 'maybe')).rejects.toThrow(/Yes, No/)
    await expect(setFact(ws, 'howHeard', 'x'.repeat(501))).rejects.toThrow(/too long/)
    expect((await readAnswers(ws)).facts.over18).toBeUndefined()
  })

  it('drops the exact options remembered for a fact whose value changes (#136)', async () => {
    await rememberAnswer(ws, { question: 'q1', label: 'Gender', fact: 'gender', value: 'Woman' })
    // Same value: the remembered option stays.
    let answers = await setFact(ws, 'gender', 'Woman')
    expect(answers.questions.q1.option).toBe('Woman')
    answers = await setFact(ws, 'gender', 'Non-binary')
    expect(answers.facts.gender?.value).toBe('Non-binary')
    expect(answers.questions.q1).toMatchObject({ fact: 'gender', confirmed: true })
    expect(answers.questions.q1.option).toBeUndefined()
  })

  it('lists the profile seeds next to the stored facts, never sensitive ones (#136)', async () => {
    const answers = await setFact(ws, 'needsSponsorship', 'no')
    const listed = savedAnswers(answers, { visaStatus: 'H-1B', needsSponsorship: 'yes', gender: 'Male' })
    expect(listed.seeds).toEqual({ visaStatus: 'H-1B', needsSponsorship: 'yes' })
    expect(listed.facts).toEqual([expect.objectContaining({ fact: 'needsSponsorship', value: 'no' })])
    expect(savedAnswers(answers).seeds).toEqual({})
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

  it('runs Sonnet once, tool-less, with no settings, MCP servers or saved session', async () => {
    const args = claudeMappingArgs()
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
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
      { id: 'q3', fact: null, answer: 'Fake answer about this company', reusable: false }
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
    expect(args.at(-1)).toMatch(/^--print=You fill in questions[\s\S]*Questions: \[\]$/)
    const { result, calls } = await run({}, 'antigravity')
    expect((await result).map((m) => m.fact)).toEqual(['gender', 'needsSponsorship', null])
    expect((await calls())[0].stdin).toBe('')
  })

  it('drops unknown ids and fact keys, and fails on malformed output, errors and timeouts', async () => {
    expect(await (await run({ FAKE_MAPPER: 'unknown' })).result).toEqual([
      { id: 'q3', fact: null, answer: 'Fake answer about this company', reusable: false },
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

describe('probable answers from the profile (#136)', () => {
  const script = join(__dirname, 'fixtures/fake-mapper.mjs')
  const QUESTIONS: MapQuestion[] = [
    { id: 'q1', question: 'What is your gender identity?', kind: 'select', options: ['Man', 'Woman'] },
    { id: 'q2', question: 'Do you need an employer to sponsor you?', kind: 'radio', options: ['Yes', 'No'] },
    { id: 'q3', question: 'Do you have experience with Go?', kind: 'radio', options: ['Yes', 'No'] },
    { id: 'q4', question: 'Describe your experience with Kubernetes', kind: 'textarea', options: [] }
  ]
  const CONTEXT: MapContext = {
    company: 'Acme Rockets',
    role: 'Backend Engineer',
    jobDescription: 'Acme builds rockets. We use Go. ' + 'j'.repeat(9000),
    profile: '# Ada Lovelace\n## Experience\n- Engineer at Initech (2019–2024): Go, Kubernetes\n' + 'p'.repeat(17000)
  }
  const run = (env: Record<string, string> = {}) =>
    mapQuestions(QUESTIONS, { agent: 'claude', command: process.execPath, args: [script], env: { ...process.env, FAKE_MAPPER_LOG: join(root, 'calls.jsonl'), ...env }, timeoutMs: 3000 }, CONTEXT)

  it('gives the model the company, role, bounded job description and profile, the questions last, and no stored value', async () => {
    await rememberAnswer(ws, { question: 'x', label: 'Gender', fact: 'gender', value: 'Female' })
    const prompt = mappingPrompt(QUESTIONS, CONTEXT)
    expect(prompt).toContain('Company: Acme Rockets')
    expect(prompt).toContain('Role: Backend Engineer')
    expect(prompt).toContain('Acme builds rockets')
    expect(prompt).toContain('Engineer at Initech')
    expect(prompt).not.toContain('j'.repeat(8001))
    expect(prompt).not.toContain('p'.repeat(16001))
    expect(prompt.lastIndexOf('Questions:')).toBeGreaterThan(prompt.indexOf('Engineer at Initech'))
    await run()
    const made = (await readFile(join(root, 'calls.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as { args: string[]; stdin: string })
    expect(made[0].stdin).toContain('Engineer at Initech')
    expect(made[0].stdin).not.toMatch(/Female/)
    // The rules: EEO, consent and unsupported questions get no answer; options are answered with one of them.
    const system = made[0].args[made[0].args.indexOf('--system-prompt') + 1]
    expect(system).toMatch(/gender, raceEthnicity/)
    expect(system).toMatch(/exactly the text of one option/)
    expect(system).toMatch(/untrusted/)
    expect(system).toMatch(/reusable: true when the answer would be the same on any employer's form/)
    expect(made[0].args[made[0].args.indexOf('--json-schema') + 1]).toContain('"reusable"')
  })

  it('treats motivation, "why us", "describe" and cover-letter questions as company-specific, whatever the model says', () => {
    for (const q of [
      'Why do you want to work at Acme?',
      'Why are you interested in this role?',
      'Why us?',
      'Why this company?',
      'What interests you about this position?',
      'Tell us about a project you are proud of',
      'Describe your experience with Kubernetes',
      'What motivates you to apply?',
      'Cover letter'
    ]) {
      expect(isCompanySpecificQuestion(q), q).toBe(true)
    }
    for (const q of ['Do you have experience with Go?', 'How many years of experience do you have with Python?', 'Do you hold a degree in computer science?']) {
      expect(isCompanySpecificQuestion(q), q).toBe(false)
    }
    const out = JSON.stringify({ structured_output: { mappings: [{ id: 'a', factKey: null, answer: 'Yes' }] } })
    // A reply without the flag is not reusable.
    expect(parseMappingOutput(out, new Set(['a']), [{ id: 'a', question: 'Go?', kind: 'text', options: [] }])).toEqual([
      { id: 'a', fact: null, answer: 'Yes', reusable: false }
    ])
  })

  it('keeps answers that are bounded, among the options, and never for a sensitive fact or an EEO question', async () => {
    expect(await run()).toEqual([
      { id: 'q1', fact: 'gender' },
      { id: 'q2', fact: 'needsSponsorship' },
      { id: 'q3', fact: null, answer: 'Yes', reusable: true },
      // The model calls it reusable; main still refuses it for a "describe" question (isCompanySpecificQuestion).
      { id: 'q4', fact: null, answer: 'Yes', reusable: true }
    ])
    // A model that over-reaches: a gender answer, an option the question lacks, a 400-character text.
    expect(await run({ FAKE_MAPPER: 'overreach' })).toEqual([
      { id: 'q1', fact: 'gender' },
      { id: 'q2', fact: 'needsSponsorship' },
      { id: 'q3', fact: null },
      { id: 'q4', fact: null }
    ])
    const out = (mappings: unknown[]) => JSON.stringify({ structured_output: { mappings } })
    const qs: MapQuestion[] = [
      { id: 'a', question: 'Are you Hispanic or Latino?', kind: 'text', options: [] },
      { id: 'b', question: 'Do you agree to the terms?', kind: 'radio', options: ['Yes', 'No'] },
      { id: 'c', question: 'Preferred office', kind: 'select', options: ['London', 'Paris'] }
    ]
    expect(
      parseMappingOutput(
        out([
          { id: 'a', factKey: null, answer: 'No' },
          { id: 'b', factKey: null, answer: 'Yes' },
          { id: 'c', factKey: null, answer: ' london ' }
        ]),
        new Set(['a', 'b', 'c']),
        qs
      )
    ).toEqual([
      { id: 'a', fact: null },
      { id: 'b', fact: null },
      { id: 'c', fact: null, answer: 'London', reusable: false }
    ])
  })
})

describe('drafting open-ended answers (#82)', () => {
  const context = { jobDescription: 'Acme builds rockets. Backend engineer, Go.', resume: '{"name":"Ada","skills":["Go"]}' }

  it('puts the job description, resume and bounded questions in the prompt, never anything else', () => {
    const prompt = draftPrompt([{ id: 'q1', question: 'Why Acme?' + 'x'.repeat(1000) }], context)
    expect(prompt).toContain('Acme builds rockets')
    expect(prompt).toContain('"skills":["Go"]')
    expect(prompt).toContain('Why Acme?')
    expect(prompt).not.toContain('x'.repeat(301))
  })

  it('runs Claude Sonnet one-shot without tools, and agy sandboxed', () => {
    const claude = claudeDraftArgs()
    expect(claude[claude.indexOf('--model') + 1]).toBe('sonnet')
    expect(claude[claude.indexOf('--tools') + 1]).toBe('')
    expect(claude).toContain('--no-session-persistence')
    const agy = agyDraftArgs('Questions: []')
    expect(agy).toContain('--sandbox')
    expect(agy.at(-1)).toMatch(/^--print=You write answers[\s\S]*Questions: \[\]$/)
  })

  it('keeps known ids with a non-empty answer only, bounded', () => {
    const out = JSON.stringify({
      structured_output: {
        answers: [
          { id: 'q1', answer: '  I like rockets.  ' },
          { id: 'q2', answer: null },
          { id: 'q3', answer: '   ' },
          { id: 'zz', answer: 'injected' },
          { id: 'q1', answer: 'twice' },
          { id: 'q4', answer: 'y'.repeat(5000) }
        ]
      }
    })
    const drafts = parseDraftOutput(out, new Set(['q1', 'q2', 'q3', 'q4']))
    expect(drafts.map((d) => d.id)).toEqual(['q1', 'q4'])
    expect(drafts[0].answer).toBe('I like rockets.')
    expect(drafts[1].answer).toHaveLength(2000)
    expect(() => parseDraftOutput('nope', new Set())).toThrow(/unexpected/)
    expect(() => parseDraftOutput(JSON.stringify({ structured_output: {} }), new Set())).toThrow(/no answers/)
  })

  it('makes no call without a job description or a resume', async () => {
    const cli = { agent: 'claude' as const, command: join(root, 'no-such-cli'), env: process.env }
    expect(await draftAnswers([{ id: 'q1', question: 'Why?' }], { ...context, jobDescription: ' ' }, cli)).toEqual([])
    expect(await draftAnswers([{ id: 'q1', question: 'Why?' }], { ...context, resume: '' }, cli)).toEqual([])
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

describe('edits the page reports (#136)', () => {
  it('keeps bounded, non-empty edits with an id, the last per field, and an http(s) URL only', () => {
    expect(
      parseEdits({
        url: 'https://jobs.lever.co/a/b/apply',
        edits: [
          { fieldId: 'radio:go', value: ' No ' },
          { fieldId: 'text:why', value: 'x'.repeat(501) },
          { fieldId: '', value: 'a' },
          { fieldId: 'text:a', value: '   ' },
          { fieldId: 7, value: 'a' },
          { fieldId: 'radio:go', value: 'Yes' },
          'junk'
        ]
      })
    ).toEqual({ url: 'https://jobs.lever.co/a/b/apply', edits: [{ fieldId: 'radio:go', value: 'Yes' }] })
    expect(parseEdits({ url: 'javascript:alert(1)', edits: [{ fieldId: 'a', value: 'b' }] }).url).toBe('')
    expect(parseEdits(null)).toEqual({ url: '', edits: [] })
    expect(parseEdits({ edits: Array.from({ length: 300 }, (_, i) => ({ fieldId: `f${i}`, value: 'v' })) }).edits).toHaveLength(200)
  })
})
