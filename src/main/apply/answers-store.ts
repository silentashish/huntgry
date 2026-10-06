import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  canonicalAnswer,
  FACT_KEYS,
  FACTS,
  isFactKey,
  type FactKey,
  type PageAnswers
} from '@shared/apply-facts'
import type { SavedAnswers } from '@shared/apply-types'

/**
 * The application answers memory (#71): the personal facts and question
 * answers the user taught autofill, so a question answered once fills itself
 * on later applications.
 *
 *   <userData>/apply-answers/<sha256(workspace)[0..32]>/answers.json
 *
 * Not in the workspace: every tailoring agent may read and write there, the
 * folder may be a git repository, and gender, race, veteran and disability
 * answers must never reach a model. Only main reads and writes this file
 * (owner-only permissions), whole and atomically (temp file + rename), one
 * write at a time per workspace. A missing or corrupt file reads as empty.
 */

let rootProvider: () => string = () => join(tmpdir(), 'huntgry-apply-answers')

/** The app points this at `<userData>/apply-answers` at startup; tests at a temp folder. */
export function setAnswersRoot(provider: string | (() => string)): void {
  rootProvider = typeof provider === 'string' ? () => provider : provider
}

export function answersFile(workspace: string): string {
  const key = createHash('sha256').update(resolve(workspace)).digest('hex').slice(0, 32)
  return join(rootProvider(), key, 'answers.json')
}

export interface StoredFact {
  value: string
  updatedAt: string
}

export interface StoredQuestion {
  /** The question as the page worded it (for the Settings list). */
  label: string
  fact: FactKey | null
  /** A direct answer (questions without a fact). */
  value?: string
  /** For a fact question: the exact option the user chose, reused when this question (same options) comes back. */
  option?: string
  /** Who mapped it: the user, or a model (a suggestion until the user confirms). */
  source: 'user' | 'model'
  confirmed: boolean
  updatedAt: string
}

export interface Answers {
  facts: Partial<Record<FactKey, StoredFact>>
  questions: Record<string, StoredQuestion>
}

/** Remembered questions kept per workspace; the oldest go first. */
export const MAX_QUESTIONS = 1000

const empty = (): Answers => ({ facts: {}, questions: {} })
const text = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null)

function normalize(raw: unknown): Answers {
  const out = empty()
  if (typeof raw !== 'object' || raw === null) return out
  const { facts, questions } = raw as Record<string, unknown>
  if (typeof facts === 'object' && facts !== null) {
    for (const [key, v] of Object.entries(facts)) {
      const value = text((v as StoredFact | null)?.value, 500)
      if (isFactKey(key) && value) out.facts[key] = { value, updatedAt: text((v as StoredFact).updatedAt, 40) ?? '' }
    }
  }
  if (typeof questions === 'object' && questions !== null) {
    for (const [key, v] of Object.entries(questions).slice(0, MAX_QUESTIONS * 2)) {
      if (typeof v !== 'object' || v === null || key.length > 300) continue
      const q = v as Record<string, unknown>
      const value = text(q.value, 500)
      const option = text(q.option, 500)
      const fact = isFactKey(q.fact) ? q.fact : null
      out.questions[key] = {
        label: text(q.label, 300) ?? '',
        fact,
        ...(value ? { value } : {}),
        ...(option && fact && q.source === 'user' ? { option } : {}),
        source: q.source === 'user' ? 'user' : 'model',
        confirmed: q.confirmed === true && q.source === 'user',
        updatedAt: text(q.updatedAt, 40) ?? ''
      }
    }
  }
  return out
}

export async function readAnswers(workspace: string): Promise<Answers> {
  try {
    return normalize(JSON.parse(await readFile(answersFile(workspace), 'utf8')))
  } catch {
    return empty()
  }
}

const locks = new Map<string, Promise<unknown>>()

/** Read-modify-write under the workspace's lock. */
function update(workspace: string, change: (answers: Answers) => Answers): Promise<Answers> {
  const file = answersFile(workspace)
  const run = (locks.get(file) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      const next = trim(change(await readAnswers(workspace)))
      await mkdir(join(file, '..'), { recursive: true, mode: 0o700 })
      const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
      await writeFile(tmp, `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
      return next
    })
  locks.set(file, run)
  return run
}

function trim(answers: Answers): Answers {
  const entries = Object.entries(answers.questions)
  if (entries.length <= MAX_QUESTIONS) return answers
  entries.sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
  return { ...answers, questions: Object.fromEntries(entries.slice(0, MAX_QUESTIONS)) }
}

export interface UserAnswer {
  question: string
  label: string
  fact: FactKey | null
  value: string
}

/**
 * The user answered a question and asked Huntgry to remember it: a question
 * that asks for a fact stores the fact (and the confirmed mapping), any other
 * question stores the answer itself.
 */
export function rememberAnswer(workspace: string, answer: UserAnswer, now = new Date()): Promise<Answers> {
  const at = now.toISOString()
  return update(workspace, (a) => {
    const facts = { ...a.facts }
    const questions = { ...a.questions }
    if (answer.fact) {
      facts[answer.fact] = { value: canonicalAnswer(answer.fact, answer.value), updatedAt: at }
      // The exact option too: the fact alone may fit several options of this question ("Yes, I am" / "Yes, with a visa").
      questions[answer.question] = {
        label: answer.label,
        fact: answer.fact,
        option: answer.value.trim().slice(0, 500),
        source: 'user',
        confirmed: true,
        updatedAt: at
      }
    } else {
      questions[answer.question] = {
        label: answer.label,
        fact: null,
        value: answer.value.trim().slice(0, 500),
        source: 'user',
        confirmed: true,
        updatedAt: at
      }
    }
    return { facts, questions }
  })
}

/** A model's mappings, unconfirmed; a question the user already answered keeps the user's entry. */
export function rememberMappings(
  workspace: string,
  mappings: ReadonlyArray<{ question: string; label: string; fact: FactKey | null }>,
  now = new Date()
): Promise<Answers> {
  const at = now.toISOString()
  return update(workspace, (a) => {
    const questions = { ...a.questions }
    for (const m of mappings) {
      if (questions[m.question]?.source === 'user') continue
      questions[m.question] = { label: m.label.slice(0, 300), fact: m.fact, source: 'model', confirmed: false, updatedAt: at }
    }
    return { ...a, questions }
  })
}

/** Forgets a fact, and the exact options remembered for questions about it (they say the same thing). */
export function forgetFact(workspace: string, fact: FactKey): Promise<Answers> {
  return update(workspace, (a) => {
    const facts = { ...a.facts }
    delete facts[fact]
    const questions = Object.fromEntries(
      Object.entries(a.questions).map(([key, q]) => {
        if (q.fact !== fact || q.option === undefined) return [key, q]
        const { option: _forgotten, ...rest } = q
        return [key, rest]
      })
    )
    return { facts, questions }
  })
}

export function forgetQuestion(workspace: string, question: string): Promise<Answers> {
  return update(workspace, (a) => {
    const questions = { ...a.questions }
    delete questions[question]
    return { ...a, questions }
  })
}

/** Forget all: the file is removed (and its folder, now empty). */
export async function clearAnswers(workspace: string): Promise<Answers> {
  const file = answersFile(workspace)
  const run = (locks.get(file) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    await rm(join(file, '..'), { recursive: true, force: true })
    return empty()
  })
  locks.set(file, run)
  return run
}

/**
 * What the page gets with a fill: the stored facts over those the profile
 * states (`seeds`), and the question memory (direct answers only when the
 * user gave them).
 */
export function pageAnswers(answers: Answers, seeds: Partial<Record<FactKey, string>> = {}): PageAnswers {
  const facts: PageAnswers['facts'] = { ...seeds }
  for (const key of FACT_KEYS) {
    const stored = answers.facts[key]
    if (stored) facts[key] = stored.value
  }
  const questions: PageAnswers['questions'] = {}
  for (const [key, q] of Object.entries(answers.questions)) {
    questions[key] = {
      fact: q.fact,
      confirmed: q.confirmed,
      ...(q.value && q.source === 'user' ? { value: q.value } : {}),
      ...(q.option && q.source === 'user' ? { option: q.option } : {})
    }
  }
  return { facts, questions }
}

/** For the Settings list (the renderer masks sensitive values until asked). */
export function savedAnswers(answers: Answers): SavedAnswers {
  return {
    facts: FACT_KEYS.filter((k) => answers.facts[k]).map((k) => ({
      fact: k,
      label: FACTS[k].label,
      sensitive: FACTS[k].sensitive,
      value: answers.facts[k]!.value,
      updatedAt: answers.facts[k]!.updatedAt
    })),
    questions: Object.entries(answers.questions)
      .filter(([, q]) => q.value && q.source === 'user')
      .map(([question, q]) => ({ question, label: q.label, value: q.value!, updatedAt: q.updatedAt }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}
